import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNavigationComment } from "./github.ts";
import { landStackThroughPullRequest } from "./land.ts";
import { commit, fakeGithub, fakeJj, landed, openPrs, ui } from "./test-fixtures.ts";

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
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github,
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

	it("preserves single-PR landing when the selected PR closes only one local slice", async () => {
		const one = commit("aaa", "feat1");
		const result = await landStackThroughPullRequest(
			{ cwd: "/repo", prNumber: 11, headBookmark: "feat1", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					fetchStack: async () => [one],
					listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
				}),
				github: fakeGithub({ listOpenPrs: async () => [openPrs()[0]] }),
				landPr: async () => {
					throw new Error("stack landing must not run");
				},
			},
		);
		assert.deepEqual(result, { status: "not-stack" });
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
