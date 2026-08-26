import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNavigationComment } from "../shared/stack/topology.ts";
import { landStackThroughPullRequest } from "./land.ts";
import { commit, fakeGithub, fakeJj, landed, openPrs, permissiveLock, ui } from "./test-fixtures.ts";

describe("stack-prefix landing", () => {
	it("lands the complete prefix through a selected stacked PR", async () => {
		const calls: number[] = [];
		let stack = [commit("aaa", "feat1"), commit("bbb", "feat2")];
		const prs = openPrs();
		const jj = fakeJj({
			fetchStack: async () => stack,
			listLocalBookmarks: async () => stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId })),
			abandonRange: async (_cwd, _trunk, mergedBookmark) => {
				stack = stack.filter((item) => !item.bookmarks.includes(mergedBookmark));
			},
		});
		const github = fakeGithub({
			listOpenPrs: async () => prs.filter((pr) => stack.some((item) => item.bookmarks.includes(pr.headRef))),
			updatePrBase: async (input) => {
				const pr = prs.find((item) => item.number === input.prNumber);
				if (pr) pr.baseRef = input.base;
			},
		});
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 12, headBookmark: "feat2", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github,
				acquirePublicationLock: permissiveLock(),
				landPr: async ({ prNumber }) => {
					calls.push(prNumber);
					return {
						handled: true,
						outcome: landed(prNumber, prNumber === 11 ? "aaa-commit" : "bbb-commit"),
					};
				},
			},
		);
		assert.equal(result.status, "stack");
		if (result.status === "stack") assert.equal(result.outcome.status, "completed");
		assert.deepEqual(calls, [11, 12]);
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
				github: fakeGithub({
					listOpenPrs: async () => [openPrs()[1]],
					listPrsForHead: async () => [],
				}),
				landPr: async () => {
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
				github: fakeGithub({
					listOpenPrs: async () => [openPrs()[1]],
					listPrsForHead: async (_repo, head) => (head === "feat1" ? [historical, openPrs()[0]] : []),
				}),
				landPr: async () => {
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
				github: fakeGithub({ listOpenPrs: async () => (stack.length > 0 ? [openPrs()[0]] : []) }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
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
				github: fakeGithub({
					listOpenPrs: async () => [openPrs()[0]],
					getPrComments: async () => [{ id: 1, body: navigation, user: "publisher" }],
				}),
				landPr: async () => {
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
