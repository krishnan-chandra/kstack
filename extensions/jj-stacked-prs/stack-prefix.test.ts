import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNavigationComment } from "../shared/stack/topology.ts";
import { landStackThroughPullRequest } from "./land.ts";
import type { NativeStack } from "./native-stack.ts";
import {
	commit,
	fakeGithub,
	fakeJj,
	fakeNativeStack,
	landed,
	openPrs,
	permissiveLock,
	readyPr,
	ui,
} from "./test-fixtures.ts";

const nativeStack: NativeStack = {
	stackNumber: 17,
	baseRef: "main",
	open: true,
	pullRequests: openPrs().map((pr) => ({
		number: pr.number,
		state: "open",
		draft: pr.draft,
		head: { ref: pr.headRef, sha: pr.headCommitId },
	})),
};

describe("stack-prefix landing", () => {
	it("lands the complete prefix with one native merge through the selected PR", async () => {
		const calls: string[] = [];
		const jj = fakeJj();
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 12, headBookmark: "feat2", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				nativeStack: fakeNativeStack({
					inspectForPullRequest: async () => nativeStack,
					mergeThrough: async ({ prNumber }) => {
						calls.push(`merge:${prNumber}`);
						return { status: "merged", stack: nativeStack };
					},
				}),
				github: fakeGithub({ listOpenPrs: async () => openPrs() }),
				acquirePublicationLock: permissiveLock(),
				preparePr: async ({ repository, prNumber, expectedHeadSha }) => {
					assert.equal(repository, "o/r");
					assert.equal(expectedHeadSha, prNumber === 11 ? "aaa-commit" : "bbb-commit");
					calls.push(`prepare:${prNumber}`);
					return { handled: true, outcome: readyPr(prNumber, expectedHeadSha, prNumber === 11 ? "feat1" : "feat2") };
				},
				landFrontier: async () => {
					assert.fail("Native stacks must not delegate individual merges");
				},
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack") assert.equal(result.outcome.status, "completed");
		assert.deepEqual(calls, ["prepare:11", "prepare:12", "merge:12"]);
		assert.deepEqual(jj.calls, ["abandon:trunk..feat2", "fetch"]);
	});

	it("blocks an unclaimed Land request before progress", async () => {
		const stack = [commit("aaa", "feat1")];
		const readyPr = { ...openPrs()[0], draft: false };
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 11, headBookmark: "feat1", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					fetchStack: async () => stack,
					listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
				}),
				nativeStack: fakeNativeStack(),
				github: fakeGithub({ listOpenPrs: async () => [readyPr] }),
				landFrontier: async () => ({ handled: false }),
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack" && result.outcome.status === "blocked") {
			assert.equal(result.outcome.blockers[0]?.code, "land-unavailable");
		} else {
			assert.fail(`expected an unavailable Land blocker: ${JSON.stringify(result)}`);
		}
	});

	it("preserves draft-readiness progress when later native preparation is unclaimed", async () => {
		let calls = 0;
		const jj = fakeJj();
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 12, headBookmark: "feat2", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				nativeStack: fakeNativeStack({ inspectForPullRequest: async () => nativeStack }),
				github: fakeGithub({ listOpenPrs: async () => openPrs() }),
				acquirePublicationLock: permissiveLock(),
				preparePr: async ({ prNumber, expectedHeadSha }) => {
					calls++;
					if (prNumber === 12) return { handled: false };
					const outcome = readyPr(prNumber, expectedHeadSha, "feat1");
					assert.ok(outcome.prState);
					outcome.prState.isDraft = calls === 1;
					return { handled: true, outcome };
				},
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack" && result.outcome.status === "partial") {
			assert.match(result.outcome.error, /pr-autopilot extension became unavailable/i);
			assert.deepEqual(result.outcome.remainingRefs, ["feat1", "feat2"]);
			assert.deepEqual(result.outcome.completedMutations, ["Marked PR #11 ready"]);
		} else {
			assert.fail("expected partial progress");
		}
		assert.equal(calls, 3);
		assert.deepEqual(jj.calls, []);
	});

	it("reports an unpublished slice as requiring publication", async () => {
		const stack = [commit("aaa", "feat1"), commit("bbb", "feat2", "aaa-commit")];
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 12, headBookmark: "feat2", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					fetchStack: async () => stack,
					listLocalBookmarks: async () => stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId })),
				}),
				nativeStack: fakeNativeStack(),
				github: fakeGithub({
					listOpenPrs: async () => [openPrs()[1]],
					listPrsForHead: async () => [],
				}),
				landFrontier: async () => {
					throw new Error("landing must not run before publication");
				},
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack" && result.outcome.status === "blocked") {
			assert.equal(result.outcome.blockers[0]?.code, "publish-required");
			assert.equal(result.outcome.blockers[0]?.ref, "feat1");
			assert.match(result.outcome.blockers[0]?.message ?? "", /publish.*before landing/i);
		} else {
			assert.fail("expected publication-required blocker");
		}
	});

	it("distinguishes multiple historical PRs from multiple open PRs", async () => {
		const stack = [commit("aaa", "feat1"), commit("bbb", "feat2", "aaa-commit")];
		const historical = { ...openPrs()[0], number: 10 };
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 12, headBookmark: "feat2", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					fetchStack: async () => stack,
					listLocalBookmarks: async () => stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId })),
				}),
				nativeStack: fakeNativeStack(),
				github: fakeGithub({
					listOpenPrs: async () => [openPrs()[1]],
					listPrsForHead: async (_repo, head) => (head === "feat1" ? [historical, openPrs()[0]] : []),
				}),
				landFrontier: async () => {
					throw new Error("landing must not run with ambiguous PR history");
				},
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack" && result.outcome.status === "blocked") {
			assert.equal(result.outcome.blockers[0]?.code, "ambiguous-pr-history");
		} else {
			assert.fail("expected ambiguous PR history blocker");
		}
	});

	it("cleans up local jj state when the selected PR closes one local slice", async () => {
		let stack = [commit("aaa", "feat1")];
		const mutations: string[] = [];
		const jj = fakeJj({
			fetchStack: async () => stack,
			listLocalBookmarks: async () => stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId })),
			abandonRange: async (_cwd, trunk, merged) => {
				mutations.push(`abandon:${trunk}..${merged}`);
				stack = [];
			},
		});
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 11, headBookmark: "feat1", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				nativeStack: fakeNativeStack(),
				github: fakeGithub({ listOpenPrs: async () => (stack.length > 0 ? [openPrs()[0]] : []) }),
				landFrontier: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack") assert.equal(result.outcome.status, "completed");
		assert.ok(mutations.includes("abandon:trunk..feat1"));
	});

	it("blocks when kstack metadata names predecessors missing from the local prefix", async () => {
		const one = commit("aaa", "feat1");
		const navigation = buildNavigationComment(
			[
				{ prNumber: 10, bookmark: "base", base: "main", status: "open" },
				{ prNumber: 11, bookmark: "feat1", base: "base", status: "open" },
			],
			"main",
		);
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 11, headBookmark: "feat1", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					fetchStack: async () => [one],
					listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
				}),
				nativeStack: fakeNativeStack(),
				github: fakeGithub({
					listOpenPrs: async () => [openPrs()[0]],
					getPrComments: async () => [{ id: 1, body: navigation, user: "publisher" }],
				}),
				landFrontier: async () => {
					throw new Error("individual landing must not run");
				},
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack" && result.outcome.status === "blocked") {
			assert.match(result.outcome.blockers.map((blocker) => blocker.message).join("\n"), /predecessors.*missing/i);
		} else {
			assert.fail("expected a blocked stack outcome");
		}
	});
});
