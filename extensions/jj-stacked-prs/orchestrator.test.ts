import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitHubAdapter } from "./github.ts";
import { GitHubError } from "./github.ts";
import { type JjAdapter, JjError } from "./jj.ts";
import {
	advanceStack,
	inspectStack,
	planStack,
	publishStack,
	requestPublicationFromInput,
	syncStack,
} from "./orchestrator.ts";
import type { BookmarkTarget, OpenPullRequest, RemoteInfo, StackCommit } from "./types.ts";

function commit(changeId: string, bookmark: string, parent = "trunk"): StackCommit {
	return {
		changeId,
		commitId: `${changeId}-commit`,
		subject: `feat: ${changeId}`,
		bookmarks: [bookmark],
		remoteBookmarks: [],
		parentCommitIds: [parent],
		empty: false,
		conflict: false,
		divergent: false,
		merge: false,
		workingCopy: false,
	};
}

function remote(): RemoteInfo {
	return {
		name: "origin",
		url: "https://github.com/o/r.git",
		redactedUrl: "https://github.com/o/r.git",
		github: { owner: "o", repo: "r" },
	};
}

function fakeJj(overrides: Partial<JjAdapter> = {}): JjAdapter & { calls: string[] } {
	const calls: string[] = [];
	const adapter: JjAdapter & { calls: string[] } = {
		calls,
		preflight: async () => ({ workspaceRoot: "/repo", jjVersion: "jj 0.44.0" }),
		resolveRevset: async (_cwd, revset) => (revset === "trunk()" ? "trunk" : `${revset}-id`),
		workingCopyChangeId: async () => undefined,
		listLocalBookmarks: async () => [
			{ name: "feat1", commitId: "aaa-commit" },
			{ name: "feat2", commitId: "bbb-commit" },
		],
		listRemoteBookmarks: async () => [],
		fetchStack: async () => [commit("aaa", "feat1"), commit("bbb", "feat2")],
		listRemotes: async () => [remote()],
		getRemote: async () => remote(),
		currentOperationId: async () => "op1",
		pushBookmark: async (_cwd, _remote, bookmark) => {
			calls.push(`push:${bookmark}`);
		},
		fetchRemote: async () => {
			calls.push("fetch");
		},
		rebaseStack: async () => {
			calls.push("rebase");
		},
		abandonRange: async (_cwd, trunk, merged) => {
			calls.push(`abandon:${trunk}..${merged}`);
		},
		...overrides,
	};
	return adapter;
}

function fakeGithub(overrides: Partial<GitHubAdapter> = {}): GitHubAdapter & { comments: string[] } {
	const comments: string[] = [];
	return {
		comments,
		getDefaultBranch: async () => "main",
		listOpenPrs: async () => [],
		listPrsForHead: async (_repo, head) => {
			const listed = overrides.listOpenPrs ? await overrides.listOpenPrs({ owner: "o", repo: "r" }, "/repo") : [];
			return listed.filter((pr) => pr.headRef === head);
		},
		getAuthenticatedUser: async () => "publisher",
		getPrStatus: async () => "open",
		getPrComments: async () => [],
		createDraftPr: async (input) => ({
			number: input.bookmark === "feat1" ? 11 : 12,
			headRef: input.bookmark,
			headCommitId: input.bookmark === "feat1" ? "aaa-commit" : "bbb-commit",
			baseRef: input.base,
			title: input.title,
			draft: true,
			url: `https://example/${input.bookmark}`,
			headOwner: "o",
		}),
		updatePrBase: async () => {},
		createOrUpdateComment: async (input) => {
			comments.push(input.body);
			return { id: 1 };
		},
		...overrides,
	};
}

function ui(overrides: { confirm?: boolean; hasUI?: boolean; select?: string } = {}) {
	return {
		hasUI: overrides.hasUI ?? true,
		confirm: async () => overrides.confirm ?? true,
		select: async () => overrides.select,
		notify: () => {},
		setStatus: () => {},
	};
}

describe("inspect and plan", () => {
	it("inspects an injected stack that is independent of this repository's trunk", async () => {
		const model = await inspectStack(
			{ cwd: "/repo", top: "feat2" },
			{ run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }), ui: ui(), jj: fakeJj() },
		);
		assert.equal(model.trunk.commitId, "trunk");
		assert.equal(model.top, "feat2");
		assert.equal(model.stack.length, 2);
		assert.equal(model.blockers.length, 0);
	});

	it("blocks a truncated publication plan", async () => {
		const planned = await planStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", maxStack: 1 },
			{ run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }), ui: ui(), jj: fakeJj() },
		);
		assert.equal(planned.status, "blocked");
		if (planned.status === "blocked") assert.ok(planned.blockers.some((blocker) => blocker.code === "truncated"));
	});
});

describe("publishStack", () => {
	it("declines, blocks, and non-UI paths perform zero mutation", async () => {
		const jj = fakeJj();
		const github = fakeGithub();
		assert.equal(
			(
				await publishStack(
					{ cwd: "/repo", top: "feat2", remote: "origin" },
					{ run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }), ui: ui({ hasUI: false }), jj, github },
				)
			).status,
			"blocked",
		);
		assert.equal(
			(
				await publishStack(
					{ cwd: "/repo", top: "feat2", remote: "origin" },
					{
						run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
						ui: ui({ confirm: false }),
						jj,
						github,
					},
				)
			).status,
			"declined",
		);
		assert.deepEqual(jj.calls, []);
		assert.equal(github.comments.length, 0);
	});

	it("creates draft PRs and comments that include every returned number", async () => {
		const github = fakeGithub();
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github,
			},
		);
		assert.equal(result.status, "completed");
		if (result.status !== "completed") return;
		assert.deepEqual(
			result.publication.pullRequests.map((pr) => pr.prNumber),
			[11, 12],
		);
		assert.equal(github.comments.length, 2);
		for (const body of github.comments) {
			assert.match(body, /#11/);
			assert.match(body, /#12/);
		}
	});

	it("repairs only a wrong base and leaves existing title/draft untouched", async () => {
		const existing: OpenPullRequest[] = [
			{
				number: 11,
				headRef: "feat1",
				headCommitId: "aaa-commit",
				baseRef: "old",
				title: "Keep me",
				draft: true,
				url: "https://example/11",
				headOwner: "o",
			},
			{
				number: 12,
				headRef: "feat2",
				headCommitId: "bbb-commit",
				baseRef: "feat1",
				title: "Also keep",
				draft: true,
				url: "https://example/12",
				headOwner: "o",
			},
		];
		let updated: { prNumber: number; base: string } | undefined;
		const github = fakeGithub({
			listOpenPrs: async () => existing,
			createDraftPr: async () => {
				throw new Error("should not create");
			},
			updatePrBase: async (input) => {
				updated = { prNumber: input.prNumber, base: input.base };
			},
		});
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					listRemoteBookmarks: async () => [
						{ name: "feat1", commitId: "aaa-commit" },
						{ name: "feat2", commitId: "bbb-commit" },
					],
				}),
				github,
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(updated, { prNumber: 11, base: "main" });
	});

	it("returns stale after confirmation when the fresh plan differs", async () => {
		let remoteBookmarks: BookmarkTarget[] = [];
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: {
					...ui(),
					confirm: async () => {
						remoteBookmarks = [{ name: "feat2", commitId: "changed" }];
						return true;
					},
				},
				jj: fakeJj({
					listRemoteBookmarks: async () => remoteBookmarks,
				}),
				github: fakeGithub(),
			},
		);
		assert.equal(result.status, "stale");
	});

	it("skips comments when the authenticated user is unknown", async () => {
		let wrote = false;
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github: fakeGithub({
					getAuthenticatedUser: async () => undefined,
					createOrUpdateComment: async () => {
						wrote = true;
						return { id: 1 };
					},
				}),
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(wrote, false);
		if (result.status === "completed") {
			assert.ok(result.commentErrors?.some((error) => /authenticated GitHub user/.test(error)));
		}
	});

	it("reports comment write failures on an otherwise completed publication", async () => {
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github: fakeGithub({
					createOrUpdateComment: async () => {
						throw new Error("comment API failed");
					},
				}),
			},
		);
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.ok(result.commentErrors?.some((error) => /comment API failed/.test(error)));
			assert.equal(result.publication.pullRequests.length, 2);
		}
	});

	it("stops later core actions after the first conclusive failure", async () => {
		const jj = fakeJj({
			pushBookmark: async (_cwd, _remote, bookmark) => {
				jj.calls.push(`push:${bookmark}`);
				if (bookmark === "feat2") throw new Error("network");
			},
		});
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub(),
			},
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") {
			assert.ok(result.completedActions.some((action) => action.kind === "create-draft-pr"));
			assert.equal(result.failedAction.kind, "push-bookmark");
		}
	});

	it("is cancelled before an action starts and indeterminate after a mutator starts", async () => {
		const controller = new AbortController();
		const cancelled = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: {
					...ui(),
					confirm: async () => {
						controller.abort();
						return true;
					},
				},
				jj: fakeJj(),
				github: fakeGithub(),
				signal: controller.signal,
			},
		);
		assert.equal(cancelled.status, "cancelled");

		const github = fakeGithub({
			createDraftPr: async () => {
				throw new GitHubError("timeout after POST", "indeterminate");
			},
		});
		const indeterminate = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github,
			},
		);
		assert.equal(indeterminate.status, "indeterminate");
	});

	it("replans residual actions after a partial first publication", async () => {
		const existing: OpenPullRequest[] = [
			{
				number: 11,
				headRef: "feat1",
				headCommitId: "aaa-commit",
				baseRef: "main",
				title: "First",
				draft: true,
				url: "https://example/11",
				headOwner: "o",
			},
		];
		const planned = await planStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					listRemoteBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
				}),
				github: fakeGithub({ listOpenPrs: async () => existing }),
			},
		);
		assert.equal(planned.status, "ok");
		if (planned.status !== "ok") return;
		assert.deepEqual(
			planned.plan.actions.map((action) => action.kind),
			["push-bookmark", "create-draft-pr"],
		);
		assert.equal(planned.plan.actions[0].kind === "push-bookmark" && planned.plan.actions[0].bookmark, "feat2");
	});
});

describe("sync and advance", () => {
	it("rebases only the selected stack after a confirmed fetch", async () => {
		const jj = fakeJj();
		const result = await syncStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{ run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }), ui: ui(), jj, github: fakeGithub() },
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(jj.calls, ["fetch", "rebase"]);
	});

	it("reports a partial sync when a later step fails after fetch", async () => {
		const jj = fakeJj();
		let fetched = false;
		const fetchRemote = jj.fetchRemote;
		jj.fetchRemote = async (...args) => {
			await fetchRemote(...args);
			fetched = true;
		};
		jj.resolveRevset = async (_cwd, revset) => {
			if (fetched) throw new JjError("resolve failed");
			return revset === "trunk()" ? "trunk" : `${revset}-id`;
		};
		const result = await syncStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{ run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }), ui: ui(), jj, github: fakeGithub() },
		);
		assert.equal(result.status, "partial");
		assert.deepEqual(jj.calls, ["fetch"]);
	});

	it("does not abandon a stack that inspection found conflicted", async () => {
		const conflicted = { ...commit("aaa", "feat1"), conflict: true };
		const jj = fakeJj({
			fetchStack: async () => [conflicted, commit("bbb", "feat2")],
		});
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat1", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listPrsForHead: async () => [
						{
							number: 11,
							headRef: "feat1",
							headCommitId: "aaa-commit",
							baseRef: "main",
							title: "x",
							draft: false,
							url: "u",
							headOwner: "o",
						},
					],
					getPrStatus: async () => "merged",
				}),
			},
		);
		assert.equal(result.status, "blocked");
		assert.deepEqual(jj.calls, []);
	});

	it("does not trust a historical merged PR for a reused bookmark", async () => {
		const jj = fakeJj();
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat1", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listPrsForHead: async () => [
						{
							number: 3,
							headRef: "feat1",
							headCommitId: "historical-commit",
							baseRef: "main",
							title: "old",
							draft: false,
							url: "u",
							headOwner: "o",
						},
					],
					getPrStatus: async () => "merged",
				}),
			},
		);
		assert.equal(result.status, "blocked");
		assert.deepEqual(jj.calls, []);
	});

	it("does not abandon when GitHub says the PR is still open", async () => {
		const jj = fakeJj();
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat1", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listOpenPrs: async () => [
						{
							number: 11,
							headRef: "feat1",
							headCommitId: "aaa-commit",
							baseRef: "main",
							title: "x",
							draft: false,
							url: "u",
							headOwner: "o",
						},
					],
					getPrStatus: async () => "open",
				}),
			},
		);
		assert.equal(result.status, "blocked");
		assert.deepEqual(jj.calls, []);
	});

	it("abandons through the merged bookmark before fetch", async () => {
		const jj = fakeJj();
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat1", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listOpenPrs: async () => [
						{
							number: 11,
							headRef: "feat1",
							headCommitId: "aaa-commit",
							baseRef: "main",
							title: "x",
							draft: false,
							url: "u",
							headOwner: "o",
						},
					],
					getPrStatus: async () => "merged",
				}),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(jj.calls, ["abandon:trunk..feat1", "fetch", "rebase"]);
	});

	it("abandons through the selected trunk revset, not a hardcoded trunk()", async () => {
		const jj = fakeJj({
			resolveRevset: async (_cwd, revset) => (revset === "main@origin" ? "custom-trunk" : `${revset}-id`),
			fetchStack: async () => [commit("aaa", "feat1", "custom-trunk"), commit("bbb", "feat2", "aaa-commit")],
		});
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat1", top: "feat2", remote: "origin", trunk: "main@origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listOpenPrs: async () => [
						{
							number: 11,
							headRef: "feat1",
							headCommitId: "aaa-commit",
							baseRef: "main",
							title: "x",
							draft: false,
							url: "u",
							headOwner: "o",
						},
					],
					getPrStatus: async () => "merged",
				}),
			},
		);
		assert.equal(result.status, "completed");
		assert.ok(jj.calls.includes("abandon:custom-trunk..feat1"));
	});

	it("does not abandon unmerged predecessors when a middle bookmark is merged", async () => {
		const jj = fakeJj({
			fetchStack: async () => [commit("aaa", "feat1"), commit("bbb", "feat2"), commit("ccc", "feat3")],
			listLocalBookmarks: async () => [
				{ name: "feat1", commitId: "aaa-commit" },
				{ name: "feat2", commitId: "bbb-commit" },
				{ name: "feat3", commitId: "ccc-commit" },
			],
		});
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat2", top: "feat3", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listPrsForHead: async (_repo, head) =>
						head === "feat2"
							? [
									{
										number: 12,
										headRef: "feat2",
										headCommitId: "bbb-commit",
										baseRef: "feat1",
										title: "x",
										draft: false,
										url: "u",
										headOwner: "o",
									},
								]
							: [],
					getPrStatus: async () => "merged",
				}),
			},
		);
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") {
			assert.ok(result.blockers.some((blocker) => /unmerged predecessor|bottom|prefix/i.test(blocker.message)));
		}
		assert.deepEqual(jj.calls, []);
	});

	it("reports a partial advance when fetch fails after abandon", async () => {
		const jj = fakeJj({
			fetchRemote: async () => {
				throw new JjError("fetch failed");
			},
		});
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat1", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listPrsForHead: async () => [
						{
							number: 11,
							headRef: "feat1",
							headCommitId: "aaa-commit",
							baseRef: "main",
							title: "x",
							draft: false,
							url: "u",
							headOwner: "o",
						},
					],
					getPrStatus: async () => "merged",
				}),
			},
		);
		assert.equal(result.status, "partial");
		assert.deepEqual(jj.calls, ["abandon:trunk..feat1"]);
	});

	it("reports an empty remainder when the merged bookmark was the top", async () => {
		const jj = fakeJj({
			fetchStack: async () => [commit("aaa", "feat1")],
			listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
		});
		const result = await advanceStack(
			{ cwd: "/repo", merged: "feat1", top: "feat1", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listOpenPrs: async () => [
						{
							number: 11,
							headRef: "feat1",
							headCommitId: "aaa-commit",
							baseRef: "main",
							title: "x",
							draft: false,
							url: "u",
							headOwner: "o",
						},
					],
					getPrStatus: async () => "merged",
				}),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(jj.calls, ["abandon:trunk..feat1", "fetch"]);
	});
});

describe("requestPublicationFromInput", () => {
	it("honors both the request and orchestrator cancellation signals", async () => {
		const request = new AbortController();
		const orchestrator = new AbortController();
		orchestrator.abort();
		const result = await requestPublicationFromInput(
			{ repositoryPath: "/repo", topBookmark: "feat2", remote: "origin", signal: request.signal },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github: fakeGithub(),
				realpath: (path) => path,
				signal: orchestrator.signal,
			},
		);
		assert.equal(result.status, "cancelled");
	});

	it("infers a unique GitHub remote and unique top", async () => {
		const result = await requestPublicationFromInput(
			{ repositoryPath: "/repo" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github: fakeGithub(),
				realpath: (path) => path,
			},
		);
		assert.equal(result.status, "completed");
	});
});
