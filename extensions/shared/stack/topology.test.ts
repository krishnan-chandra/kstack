import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type GitHubComment, GitHubError, type GitHubGateway } from "../github.ts";
import {
	buildNavigationComment,
	createNavigationCommentStore,
	type NavigationEntry,
	type StackTopologySlice,
} from "./topology.ts";

const repository = { owner: "o", repo: "r" };
const bottomSlice = {
	ref: "feat1",
	prNumber: 11,
	targetBase: "refs/heads/main",
	createPr: false,
	draft: false,
} satisfies StackTopologySlice;
const topSlice = {
	ref: "feat2",
	prNumber: 12,
	targetBase: "feat1",
	createPr: false,
	draft: true,
} satisfies StackTopologySlice;
const published = [bottomSlice, topSlice];
const stackEntries: NavigationEntry[] = [
	{ prNumber: 11, bookmark: "feat1", base: "main", status: "open" },
	{ prNumber: 12, bookmark: "feat2", base: "feat1", status: "draft" },
];
const bottomEntries = stackEntries.slice(0, 1);

type CommentWrite = Parameters<GitHubGateway["createOrUpdateComment"]>[0];

interface GatewayFixtureOptions {
	authenticatedUser?: string | null;
	commentsByPr?: ReadonlyMap<number, readonly GitHubComment[]>;
	getPrComments?: GitHubGateway["getPrComments"];
	getPrStatus?: GitHubGateway["getPrStatus"];
	createOrUpdateComment?: GitHubGateway["createOrUpdateComment"];
}

function gatewayFixture(options: GatewayFixtureOptions = {}) {
	const commentReads: number[] = [];
	const statusReads: number[] = [];
	const writes: CommentWrite[] = [];
	const getPrComments =
		options.getPrComments ??
		(async (_repo, prNumber) => {
			return [...(options.commentsByPr?.get(prNumber) ?? [])];
		});
	const getPrStatus = options.getPrStatus ?? (async () => "open" as const);
	const createOrUpdateComment = options.createOrUpdateComment ?? (async () => ({ id: 1 }));
	const gateway = {
		getDefaultBranch: async () => "main",
		listOpenPrs: async () => [],
		listPrsForHead: async () => [],
		getAuthenticatedUser: async () =>
			options.authenticatedUser === null ? undefined : (options.authenticatedUser ?? "publisher"),
		getPrStatus: async (repo, prNumber, cwd, signal) => {
			statusReads.push(prNumber);
			return getPrStatus(repo, prNumber, cwd, signal);
		},
		getPrComments: async (repo, prNumber, cwd, signal) => {
			commentReads.push(prNumber);
			return getPrComments(repo, prNumber, cwd, signal);
		},
		getMergeCommit: async () => ({
			merged: false,
			mergeCommitOid: undefined,
			headCommitId: "head",
			headRef: "feat1",
		}),
		getAllowedMergeMethods: async () => ["squash" as const],
		getRemoteBranchSha: async () => undefined,
		markPrReady: async () => {},
		deleteRemoteBranch: async () => "deleted" as const,
		createDraftPr: async () => ({
			number: 11,
			headRef: "feat1",
			headCommitId: "head",
			baseRef: "main",
			title: "feat1",
			draft: true,
			url: "https://example/11",
			headOwner: "o",
		}),
		updatePrBase: async () => {},
		createOrUpdateComment: async (input) => {
			writes.push(input);
			return createOrUpdateComment(input);
		},
	} satisfies GitHubGateway;
	return { gateway, commentReads, statusReads, writes };
}

async function reconcile(gateway: GitHubGateway, slices: readonly StackTopologySlice[] = published) {
	return createNavigationCommentStore(gateway).reconcile({
		repo: repository,
		defaultBranch: "main",
		published: slices,
		cwd: "/repo",
	});
}

function ownedComment(id: number, body: string): GitHubComment {
	return { id, body, user: "publisher" };
}

describe("navigation comment reconciliation", () => {
	it("skips two byte-identical owned navigation comments", async () => {
		const body = buildNavigationComment(stackEntries, "main");
		const fixture = gatewayFixture({
			commentsByPr: new Map([
				[11, [ownedComment(1, body)]],
				[12, [ownedComment(2, body)]],
			]),
		});

		const result = await reconcile(fixture.gateway);

		assert.deepEqual(fixture.commentReads, [11, 12]);
		assert.deepEqual(fixture.writes, []);
		assert.deepEqual(result, { completed: [], errors: [] });
	});

	it("creates a missing comment and records the remote mutation", async () => {
		const fixture = gatewayFixture();

		const result = await reconcile(fixture.gateway, [bottomSlice]);

		assert.equal(fixture.writes.length, 1);
		assert.equal(fixture.writes[0]?.existingCommentId, undefined);
		assert.equal(fixture.writes[0]?.body, buildNavigationComment(bottomEntries, "main"));
		assert.deepEqual(result.completed, [{ kind: "create-nav-comment", prNumber: 11 }]);
		assert.deepEqual(result.errors, []);
	});

	it("updates a changed owned comment and records the remote mutation", async () => {
		const fixture = gatewayFixture({
			commentsByPr: new Map([[11, [ownedComment(7, `${buildNavigationComment(bottomEntries, "main")}\n`)]]]),
		});

		const result = await reconcile(fixture.gateway, [bottomSlice]);

		assert.equal(fixture.writes.length, 1);
		assert.equal(fixture.writes[0]?.existingCommentId, 7);
		assert.equal(fixture.writes[0]?.body, buildNavigationComment(bottomEntries, "main"));
		assert.deepEqual(result.completed, [{ kind: "update-nav-comment", prNumber: 11 }]);
		assert.deepEqual(result.errors, []);
	});

	it("uses exact body equality for base, status, membership, and whitespace changes", async () => {
		const expected = buildNavigationComment(bottomEntries, "main");
		const cases: readonly [string, string][] = [
			["base", buildNavigationComment([{ prNumber: 11, bookmark: "feat1", base: "old-base", status: "open" }], "main")],
			["status", buildNavigationComment([{ prNumber: 11, bookmark: "feat1", base: "main", status: "draft" }], "main")],
			["membership", buildNavigationComment(stackEntries, "main")],
			["whitespace", `${expected}\n`],
		];

		for (const [label, body] of cases) {
			const fixture = gatewayFixture({ commentsByPr: new Map([[11, [ownedComment(7, body)]]]) });

			const result = await reconcile(fixture.gateway, [bottomSlice]);

			assert.equal(fixture.writes.length, 1, label);
			assert.equal(fixture.writes[0]?.body, expected, label);
			assert.deepEqual(result.completed, [{ kind: "update-nav-comment", prNumber: 11 }], label);
		}
	});

	it("writes only the slice whose owned comment differs", async () => {
		const body = buildNavigationComment(stackEntries, "main");
		const fixture = gatewayFixture({
			commentsByPr: new Map([
				[11, [ownedComment(1, body)]],
				[12, [ownedComment(2, `${body}\n`)]],
			]),
		});

		const result = await reconcile(fixture.gateway);

		assert.deepEqual(
			fixture.writes.map((write) => write.prNumber),
			[12],
		);
		assert.deepEqual(result.completed, [{ kind: "update-nav-comment", prNumber: 12 }]);
	});

	it("does not treat foreign, unmarked, or unknown-author comments as owned", async () => {
		const body = buildNavigationComment(bottomEntries, "main");
		const cases: readonly [string, GitHubComment][] = [
			["foreign author", { id: 1, body, user: "someone-else" }],
			["missing marker", { id: 2, body: body.replace("<!-- kstack-stack-nav -->\n", ""), user: "publisher" }],
			["unknown author", { id: 3, body, user: undefined }],
		];

		for (const [label, comment] of cases) {
			const fixture = gatewayFixture({ commentsByPr: new Map([[11, [comment]]]) });

			const result = await reconcile(fixture.gateway, [bottomSlice]);

			assert.equal(fixture.writes.length, 1, label);
			assert.equal(fixture.writes[0]?.existingCommentId, undefined, label);
			assert.deepEqual(result.completed, [{ kind: "create-nav-comment", prNumber: 11 }], label);
		}
	});

	it("keeps fresh ancestor status reads before skipping an unchanged comment", async () => {
		const entries: NavigationEntry[] = [
			{ prNumber: 10, bookmark: "landed", base: "main", status: "open" },
			...bottomEntries,
		];
		const fixture = gatewayFixture({
			commentsByPr: new Map([[11, [ownedComment(1, buildNavigationComment(entries, "main"))]]]),
		});

		const result = await reconcile(fixture.gateway, [bottomSlice]);

		assert.deepEqual(fixture.commentReads, [11]);
		assert.deepEqual(fixture.statusReads, [10]);
		assert.deepEqual(fixture.writes, []);
		assert.deepEqual(result.completed, []);
	});

	it("rewrites an owned comment when a fresh ancestor status changes", async () => {
		const entries: NavigationEntry[] = [
			{ prNumber: 10, bookmark: "landed", base: "main", status: "open" },
			...bottomEntries,
		];
		const controller = new AbortController();
		const seenSignals: Array<AbortSignal | undefined> = [];
		const fixture = gatewayFixture({
			commentsByPr: new Map([[11, [ownedComment(1, buildNavigationComment(entries, "main"))]]]),
			getPrStatus: async (_repo, _prNumber, _cwd, signal) => {
				seenSignals.push(signal);
				return "merged";
			},
			createOrUpdateComment: async (input) => {
				seenSignals.push(input.signal);
				return { id: 1 };
			},
		});

		const result = await createNavigationCommentStore(fixture.gateway).reconcile({
			repo: repository,
			defaultBranch: "main",
			published: [bottomSlice],
			cwd: "/repo",
			signal: controller.signal,
		});

		assert.deepEqual(seenSignals, [controller.signal, controller.signal]);
		assert.equal(fixture.writes.length, 1);
		assert.match(fixture.writes[0]?.body ?? "", /\| #10 .* Merged \|/);
		assert.deepEqual(result.completed, [{ kind: "update-nav-comment", prNumber: 11 }]);
	});

	it("keeps read failures as warnings and skips writes for failed reads", async () => {
		const body = buildNavigationComment(stackEntries, "main");
		const fixture = gatewayFixture({
			getPrComments: async (_repo, prNumber) => {
				if (prNumber === 11) throw new Error("comments unavailable");
				return [ownedComment(2, body)];
			},
		});

		const result = await reconcile(fixture.gateway);

		assert.deepEqual(fixture.commentReads, [11, 12]);
		assert.deepEqual(fixture.writes, []);
		assert.deepEqual(result.completed, []);
		assert.deepEqual(result.errors, ["PR #11: comments unavailable"]);
	});

	it("warns and performs no reads or writes when comment ownership is unknown", async () => {
		const fixture = gatewayFixture({ authenticatedUser: null });

		const result = await reconcile(fixture.gateway, [bottomSlice]);

		assert.deepEqual(fixture.commentReads, []);
		assert.deepEqual(fixture.writes, []);
		assert.deepEqual(result, {
			completed: [],
			errors: ["Navigation comments skipped: could not determine the authenticated GitHub user."],
		});
	});

	it("stops after a conclusive write failure without recording a completed mutation", async () => {
		const fixture = gatewayFixture({
			createOrUpdateComment: async () => {
				throw new Error("write rejected");
			},
		});

		const result = await reconcile(fixture.gateway);

		assert.deepEqual(
			fixture.writes.map((write) => write.prNumber),
			[11],
		);
		assert.deepEqual(result, { completed: [], errors: ["PR #11: write rejected"] });
	});

	it("keeps a successful write completed when a later write fails", async () => {
		const fixture = gatewayFixture({
			createOrUpdateComment: async (input) => {
				if (input.prNumber === 12) throw new Error("later write rejected");
				return { id: 1 };
			},
		});

		const result = await reconcile(fixture.gateway);

		assert.deepEqual(
			fixture.writes.map((write) => write.prNumber),
			[11, 12],
		);
		assert.deepEqual(result, {
			completed: [{ kind: "create-nav-comment", prNumber: 11 }],
			errors: ["PR #12: later write rejected"],
		});
	});

	it("returns an indeterminate write without recording a completed mutation", async () => {
		const fixture = gatewayFixture({
			createOrUpdateComment: async () => {
				throw new GitHubError("acceptance unknown", "indeterminate");
			},
		});

		const result = await reconcile(fixture.gateway);

		assert.deepEqual(
			fixture.writes.map((write) => write.prNumber),
			[11],
		);
		assert.deepEqual(result, {
			completed: [],
			errors: [],
			indeterminate: { kind: "nav-comment", prNumber: 11, error: "acceptance unknown" },
		});
	});

	it("passes cancellation to comment reads and does not write after an aborted read", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled comment read"));
		const fixture = gatewayFixture({
			getPrComments: async (_repo, _prNumber, _cwd, signal) => {
				assert.equal(signal, controller.signal);
				signal?.throwIfAborted();
				return [];
			},
		});

		const result = await createNavigationCommentStore(fixture.gateway).reconcile({
			repo: repository,
			defaultBranch: "main",
			published: [bottomSlice],
			cwd: "/repo",
			signal: controller.signal,
		});

		assert.deepEqual(fixture.writes, []);
		assert.deepEqual(result.completed, []);
		assert.deepEqual(result.errors, ["PR #11: cancelled comment read"]);
	});
});
