import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import { runNativeLand } from "./native-land.ts";
import type { NativeStack, NativeStackGateway } from "./native-stack.ts";
import type { ResolvedOrchestratorDeps } from "./orchestrator.ts";
import { commit, fakeGithub, fakeJj, ui } from "./test-fixtures.ts";
import type { InspectModel } from "./types.ts";

const repository = { owner: "o", repo: "r" };
const options = {
	cwd: "/repo",
	top: "feat2",
	remote: "origin",
	readiness: "check" as const,
	method: "squash" as const,
};
const slices = [
	{
		bookmark: "feat1",
		prNumber: 11,
		url: "https://example/11",
		headCommitId: "aaa-commit",
		baseRef: "main",
		draft: false,
		alreadyMerged: false,
	},
	{
		bookmark: "feat2",
		prNumber: 12,
		url: "https://example/12",
		headCommitId: "bbb-commit",
		baseRef: "feat1",
		draft: false,
		alreadyMerged: false,
	},
];
const model: InspectModel = {
	schemaVersion: 1,
	jjVersion: "jj 0.44.0",
	trunk: { revset: "trunk()", commitId: "trunk" },
	top: "feat2",
	topCommitId: "bbb-commit",
	localBookmarks: ["feat1", "feat2"],
	stack: [commit("aaa", "feat1"), commit("bbb", "feat2", "aaa-commit")],
	slices: [
		{ bookmark: "feat1", baseBookmark: null, changeIds: ["aaa"], subject: "one" },
		{ bookmark: "feat2", baseBookmark: "feat1", changeIds: ["bbb"], subject: "two" },
	],
	truncated: false,
	maxStack: 50,
	blockers: [],
};
const nativeStack: NativeStack = {
	stackNumber: 17,
	baseRef: "main",
	baseSha: "trunk-sha",
	open: true,
	pullRequests: slices.map((slice) => ({
		number: slice.prNumber,
		state: "open",
		draft: false,
		head: { ref: slice.bookmark, sha: slice.headCommitId },
	})),
};

function ready(prNumber: number, sha: string): AutopilotResult {
	return {
		status: "merge-ready",
		mergeReady: true,
		cyclesCompleted: 0,
		blockedReasons: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		prState: {
			number: prNumber,
			title: "ready",
			state: "open",
			isDraft: false,
			headSha: sha,
			verifiedHeadSha: sha,
			baseRef: prNumber === 11 ? "main" : "feat1",
			headRef: prNumber === 11 ? "feat1" : "feat2",
			mergeable: "mergeable",
			mergeStateStatus: "CLEAN",
			checks: [],
			threads: [],
			hasUnresolvedThreads: false,
		},
	};
}

function gateway(overrides: Partial<NativeStackGateway> = {}): NativeStackGateway {
	return {
		preflight: async () => ({ status: "available", version: "0.1.0" }),
		baseUsesMergeQueue: async () => false,
		inspectForPullRequest: async () => nativeStack,
		link: async () => nativeStack,
		mergeThrough: async () => ({ status: "enqueued", stack: nativeStack }),
		...overrides,
	};
}

function deps(overrides: Partial<ResolvedOrchestratorDeps> = {}): ResolvedOrchestratorDeps {
	return {
		run: async () => ({ kind: "ok" as const, code: 0, stdout: ".\n", stderr: "" }),
		ui: ui({ hasUI: false }),
		jj: fakeJj(),
		github: fakeGithub(),
		nativeStack: false,
		preparePr: async ({ prNumber, expectedHeadSha }: { prNumber: number; expectedHeadSha: string }) => ({
			handled: true as const,
			outcome: ready(prNumber, expectedHeadSha),
		}),
		...overrides,
	};
}

describe("native landing failures", () => {
	it("rejects a changed generation before merge submission", async () => {
		let mergeCalls = 0;
		const native = gateway({
			inspectForPullRequest: async () => ({
				...nativeStack,
				pullRequests: nativeStack.pullRequests.map((pr, index) =>
					index === 1 ? { ...pr, head: { ...pr.head, sha: "changed" } } : pr,
				),
			}),
			mergeThrough: async () => {
				mergeCalls++;
				return { status: "enqueued", stack: nativeStack };
			},
		});
		const result = await runNativeLand(options, deps(), "squash", model, slices, nativeStack, repository, native);
		assert.equal(result.status, "partial");
		assert.equal(mergeCalls, 0);
	});

	for (const status of ["failed", "indeterminate"] as const) {
		it(`preserves a ${status} merge submission result`, async () => {
			const native = gateway({ mergeThrough: async () => ({ status, error: `${status} merge` }) });
			const result = await runNativeLand(options, deps(), "squash", model, slices, nativeStack, repository, native);
			assert.equal(result.status, status === "failed" ? "partial" : "indeterminate");
		});
	}

	it("returns queued after a bounded watch timeout without jj cleanup", async () => {
		let clock = 0;
		const jj = fakeJj();
		const result = await runNativeLand(
			{ ...options, readiness: "watch" },
			deps({
				jj,
				now: () => clock,
				sleep: async () => {
					clock = 30 * 60_000;
				},
			}),
			"squash",
			model,
			slices,
			nativeStack,
			repository,
			gateway(),
		);
		assert.equal(result.status, "queued");
		assert.ok(!jj.calls.some((call) => call.startsWith("abandon:")));
	});

	it("stops a queued watch when native membership changes", async () => {
		let clock = 0;
		let inspections = 0;
		const result = await runNativeLand(
			{ ...options, readiness: "watch" },
			deps({
				now: () => clock,
				sleep: async () => {
					clock += 10_000;
				},
			}),
			"squash",
			model,
			slices,
			nativeStack,
			repository,
			gateway({
				inspectForPullRequest: async () => {
					inspections++;
					return inspections === 1 ? nativeStack : undefined;
				},
			}),
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") assert.match(result.error, /membership changed/);
	});

	it("stops a queued watch when a member closes without merging", async () => {
		let clock = 0;
		const closed = {
			...nativeStack,
			pullRequests: nativeStack.pullRequests.map((pr, index) =>
				index === 0 ? { ...pr, state: "closed" as const } : pr,
			),
		};
		const result = await runNativeLand(
			{ ...options, readiness: "watch" },
			deps({
				now: () => clock,
				sleep: async () => {
					clock += 10_000;
				},
			}),
			"squash",
			model,
			slices,
			nativeStack,
			repository,
			gateway({ inspectForPullRequest: async () => closed }),
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") assert.match(result.error, /closed without merging/);
	});

	it("returns partial recovery state when jj cleanup fails", async () => {
		const jj = fakeJj({
			abandonRange: async () => {
				throw new Error("abandon failed");
			},
		});
		const merged = { ...nativeStack, pullRequests: nativeStack.pullRequests.map((pr) => ({ ...pr, mergedAt: "now" })) };
		const result = await runNativeLand(
			options,
			deps({ jj }),
			"squash",
			model,
			slices,
			nativeStack,
			repository,
			gateway({ mergeThrough: async () => ({ status: "merged", stack: merged }) }),
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") assert.deepEqual(result.recoveryOperationIds, ["op1"]);
	});

	it("stops cleanup when a merged commit is missing from refreshed trunk", async () => {
		const deleted: string[] = [];
		const merged = {
			...nativeStack,
			pullRequests: nativeStack.pullRequests.map((pr) => ({ ...pr, mergedAt: "now" })),
		};
		const result = await runNativeLand(
			options,
			deps({
				jj: fakeJj({ areAncestors: async () => [true, false] }),
				github: fakeGithub({
					deleteRemoteBranch: async (_repo, branch) => {
						deleted.push(branch);
						return "deleted";
					},
				}),
			}),
			"squash",
			model,
			slices,
			nativeStack,
			repository,
			gateway({ mergeThrough: async () => ({ status: "merged", stack: merged }) }),
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") assert.match(result.error, /merge-12 is not on refreshed trunk/);
		assert.deepEqual(deleted, []);
	});

	it("skips deleting a remote branch whose head changed", async () => {
		const deleted: string[] = [];
		const merged = {
			...nativeStack,
			pullRequests: nativeStack.pullRequests.map((pr) => ({ ...pr, mergedAt: "now" })),
		};
		const result = await runNativeLand(
			options,
			deps({
				github: fakeGithub({
					getRemoteBranchSha: async (_repo, branch) => (branch === "feat1" ? "changed" : "bbb-commit"),
					deleteRemoteBranch: async (_repo, branch) => {
						deleted.push(branch);
						return "deleted";
					},
				}),
			}),
			"squash",
			model,
			slices,
			nativeStack,
			repository,
			gateway({ mergeThrough: async () => ({ status: "merged", stack: merged }) }),
		);
		assert.equal(result.status, "completed");
		if (result.status !== "completed") return;
		assert.deepEqual(deleted, ["feat2"]);
		assert.ok(result.warnings.some((warning) => warning.includes("Skipped deleting feat1")));
	});

	it("does not clean up jj when post-merge PR verification fails", async () => {
		const jj = fakeJj();
		const merged = { ...nativeStack, pullRequests: nativeStack.pullRequests.map((pr) => ({ ...pr, mergedAt: "now" })) };
		const result = await runNativeLand(
			options,
			deps({
				jj,
				github: fakeGithub({
					getMergeCommit: async () => ({
						merged: false,
						mergeCommitOid: undefined,
						headCommitId: "aaa-commit",
						headRef: "feat1",
					}),
				}),
			}),
			"squash",
			model,
			slices,
			nativeStack,
			repository,
			gateway({ mergeThrough: async () => ({ status: "merged", stack: merged }) }),
		);
		assert.equal(result.status, "partial");
		assert.ok(!jj.calls.some((call) => call.startsWith("abandon:")));
	});
});
