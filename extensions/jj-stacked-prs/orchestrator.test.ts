import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "./github.ts";
import { JjError } from "./jj.ts";
import { landStack, landStackFromTool } from "./land.ts";
import {
	advanceStack,
	inspectStack,
	planStack,
	publishStack,
	publishStackFromTool,
	requestPublicationFromInput,
	syncStack,
} from "./orchestrator.ts";
import { commit, fakeGithub, fakeJj, landed, openPrs, ui } from "./test-fixtures.ts";
import type { BookmarkTarget, OpenPullRequest } from "./types.ts";

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

	it("marks draft PRs ready when publish is asked to", async () => {
		const ready: number[] = [];
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin", ready: true },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj: fakeJj(),
				github: fakeGithub({
					markPrReady: async (_repo, prNumber) => {
						ready.push(prNumber);
					},
				}),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(ready, [11, 12]);
	});

	it("publishes from the model tool without prompting", async () => {
		const jj = fakeJj();
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: {
					...ui({ hasUI: false }),
					confirm: async () => {
						throw new Error("the model tool must not prompt");
					},
				},
				jj,
				github: fakeGithub(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(jj.calls, ["push:feat1", "push:feat2"]);
	});

	it("replans and refuses a stale model-tool publication", async () => {
		let remoteReads = 0;
		const jj = fakeJj({
			listRemoteBookmarks: async () => {
				remoteReads++;
				return remoteReads === 1 ? [] : [{ name: "feat2", commitId: "changed" }];
			},
		});
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj,
				github: fakeGithub(),
			},
		);
		assert.equal(result.status, "stale");
		assert.deepEqual(jj.calls, []);
	});

	it("creates draft PRs with generated slice metadata and comments that include every returned number", async () => {
		const created: Array<{ bookmark: string; title: string; body: string }> = [];
		const github = fakeGithub({
			createDraftPr: async (input) => {
				created.push({ bookmark: input.bookmark, title: input.title, body: input.body });
				return {
					number: input.bookmark === "feat1" ? 11 : 12,
					headRef: input.bookmark,
					headCommitId: input.bookmark === "feat1" ? "aaa-commit" : "bbb-commit",
					baseRef: input.base,
					title: input.title,
					draft: true,
					url: `https://example/${input.bookmark}`,
					headOwner: "o",
				};
			},
		});
		const metadataRequests: Array<{ bookmark: string; baseRevset: string }> = [];
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github,
				generatePrMetadata: async (request) => {
					metadataRequests.push({ bookmark: request.bookmark, baseRevset: request.baseRevset });
					return {
						title: `Title for ${request.bookmark}`,
						body: `## Summary\n\n- Summary for ${request.bookmark}.\n\n## Review guide\n\n1. **Flow** — Verify ${request.bookmark}.`,
					};
				},
			},
		);
		assert.equal(result.status, "completed");
		if (result.status !== "completed") return;
		assert.deepEqual(
			result.publication.pullRequests.map((pr) => pr.prNumber),
			[11, 12],
		);
		assert.deepEqual(metadataRequests, [
			{ bookmark: "feat1", baseRevset: "trunk()" },
			{ bookmark: "feat2", baseRevset: 'bookmarks(exact:"feat1")' },
		]);
		assert.deepEqual(created, [
			{
				bookmark: "feat1",
				title: "Title for feat1",
				body: "## Summary\n\n- Summary for feat1.\n\n## Review guide\n\n1. **Flow** — Verify feat1.",
			},
			{
				bookmark: "feat2",
				title: "Title for feat2",
				body: "## Summary\n\n- Summary for feat2.\n\n## Review guide\n\n1. **Flow** — Verify feat2.",
			},
		]);
		assert.equal(github.comments.length, 2);
		for (const body of github.comments) {
			assert.match(body, /#11/);
			assert.match(body, /#12/);
		}
	});

	it("fails metadata generation before the first remote mutation", async () => {
		const jj = fakeJj();
		let created = false;
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj,
				github: fakeGithub({
					createDraftPr: async () => {
						created = true;
						throw new Error("must not create");
					},
				}),
				generatePrMetadata: async () => {
					throw new Error("model unavailable");
				},
			},
		);
		assert.equal(result.status, "failed");
		assert.deepEqual(jj.calls, []);
		assert.equal(created, false);
	});

	it("detects a stale plan if the stack changes while metadata is generating", async () => {
		let callCount = 0;
		const jj = fakeJj({
			listLocalBookmarks: async () => {
				callCount++;
				if (callCount > 2) {
					return [
						{ name: "feat1", commitId: "aaa-commit" },
						{ name: "feat2", commitId: "ccc-commit" },
					];
				}
				return [
					{ name: "feat1", commitId: "aaa-commit" },
					{ name: "feat2", commitId: "bbb-commit" },
				];
			},
		});
		let created = false;
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj,
				github: fakeGithub({
					createDraftPr: async () => {
						created = true;
						throw new Error("must not create");
					},
				}),
				generatePrMetadata: async (request) => ({
					title: `Title for ${request.bookmark}`,
					body: `## Summary\n\n- Summary.\n\n## Review guide\n\n1. **Flow** — Verify.`,
				}),
			},
		);
		assert.equal(result.status, "stale");
		assert.deepEqual(jj.calls, []);
		assert.equal(created, false);
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

describe("landStack", () => {
	it("blocks a mismatched base chain before any mutation", async () => {
		const jj = fakeJj();
		const github = fakeGithub({
			listOpenPrs: async () => [{ ...openPrs()[0] }, { ...openPrs()[1], baseRef: "wrong" }],
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github,
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") {
			assert.ok(result.blockers.some((blocker) => blocker.code === "base-chain-mismatch"));
		}
		assert.deepEqual(jj.calls, []);
	});

	it("lands three-step order: ready, land, advance, republish, delete", async () => {
		const calls: string[] = [];
		let stack = [commit("aaa", "feat1"), commit("bbb", "feat2")];
		const prs = openPrs();
		const jj = fakeJj({
			fetchStack: async () => stack,
			listLocalBookmarks: async () => stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId })),
			abandonRange: async (_cwd, trunk, merged) => {
				calls.push(`abandon:${trunk}..${merged}`);
				stack = stack.filter((item) => !item.bookmarks.includes(merged));
			},
		});
		const github = fakeGithub({
			listOpenPrs: async () => prs.filter((pr) => stack.some((item) => item.bookmarks.includes(pr.headRef))),
			updatePrBase: async (input) => {
				const pr = prs.find((item) => item.number === input.prNumber);
				if (pr) pr.baseRef = input.base;
			},
			markPrReady: async (_repo, prNumber) => {
				calls.push(`ready:${prNumber}`);
			},
			deleteRemoteBranch: async (_repo, branch) => {
				calls.push(`delete:${branch}`);
				return "deleted";
			},
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github,
				landPr: async ({ prNumber }) => {
					calls.push(`land:${prNumber}`);
					return {
						handled: true,
						outcome: landed(prNumber, prNumber === 11 ? "aaa-commit" : "bbb-commit"),
					};
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(
			calls.filter(
				(item) =>
					item.startsWith("ready:") ||
					item.startsWith("land:") ||
					item.startsWith("abandon:") ||
					item.startsWith("delete:"),
			),
			[
				"ready:11",
				"land:11",
				"abandon:trunk..feat1",
				"delete:feat1",
				"land:12",
				"abandon:trunk..feat2",
				"delete:feat2",
			],
		);
	});

	it("resumes an already-merged bottom PR with advance only", async () => {
		const calls: string[] = [];
		let stack = [commit("aaa", "feat1"), commit("bbb", "feat2")];
		const prs = openPrs().map((pr) => (pr.number === 11 ? { ...pr, draft: false } : pr));
		const jj = fakeJj({
			fetchStack: async () => stack,
			listLocalBookmarks: async () => stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId })),
			abandonRange: async (_cwd, trunk, merged) => {
				calls.push(`abandon:${trunk}..${merged}`);
				stack = stack.filter((item) => !item.bookmarks.includes(merged));
			},
		});
		const github = fakeGithub({
			listOpenPrs: async () =>
				prs.filter((pr) => pr.headRef !== "feat1" && stack.some((item) => item.bookmarks.includes(pr.headRef))),
			listPrsForHead: async (_repo, head) => prs.filter((pr) => pr.headRef === head),
			getPrStatus: async (_repo, prNumber) => (prNumber === 11 ? "merged" : "open"),
			updatePrBase: async (input) => {
				const pr = prs.find((item) => item.number === input.prNumber);
				if (pr) pr.baseRef = input.base;
			},
		});
		const result = await landStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: {
					...ui({ hasUI: false }),
					confirm: async () => {
						throw new Error("the model tool must not prompt");
					},
				},
				jj,
				github,
				landPr: async ({ prNumber }) => {
					calls.push(`land:${prNumber}`);
					return { handled: true, outcome: landed(prNumber, "bbb-commit") };
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(calls, ["abandon:trunk..feat1", "land:12", "abandon:trunk..feat2"]);
	});

	it("stops without advancing when land reports partially-landed", async () => {
		const jj = fakeJj();
		const result = await landStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => openPrs() }),
				landPr: async () => ({
					handled: true,
					outcome: {
						status: "partially-landed",
						frontiers: [
							{
								prNumber: 11,
								url: "https://example/11",
								expectedHeadSha: "aaa-commit",
								method: "squash",
								state: "queued",
							},
						],
						autopilotRan: true,
						remainingBookmarks: [],
						completedMutations: ["GitHub accepted merge/queue request for PR #11"],
						blockers: ["unverified"],
					},
				}),
			},
		);
		assert.equal(result.status, "partial");
		assert.deepEqual(jj.calls, []);
	});

	it("keeps structured progress when trunk ancestry lookup throws", async () => {
		const jj = fakeJj({
			isAncestor: async () => {
				throw new JjError("lookup failed");
			},
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => openPrs() }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") {
			assert.match(result.error, /lookup failed/);
			assert.equal(result.frontiers[0]?.prNumber, 11);
			assert.equal(result.frontiers[0]?.state, "landed");
			assert.ok(result.completedMutations.some((line) => /accepted merge\/queue request for PR #11/.test(line)));
			assert.ok(result.recoveryOperationIds.length > 0);
		}
	});

	it("does not advance when the merged PR head differs from the pinned head", async () => {
		const jj = fakeJj({
			abandonRange: async () => {
				throw new Error("advance must not run");
			},
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listOpenPrs: async () => openPrs(),
					getMergeCommit: async () => ({
						merged: true,
						mergeCommitOid: "merge-11",
						headCommitId: "different-head",
						headRef: "feat1",
					}),
				}),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") assert.match(result.error, /head .* does not match pinned head/);
		assert.ok(!jj.calls.some((call) => call.startsWith("abandon:")));
	});

	it("stops when the merge commit is not on trunk after fetch", async () => {
		const jj = fakeJj({
			isAncestor: async () => false,
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => openPrs() }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") {
			assert.match(result.error, /not an ancestor/);
			assert.deepEqual(result.remainingBookmarks, ["feat2"]);
		}
	});

	it("reports a branch deletion failure and continues", async () => {
		let stack = [commit("aaa", "feat1")];
		const jj = fakeJj({
			fetchStack: async () => stack,
			listLocalBookmarks: async () => stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId })),
			abandonRange: async () => {
				stack = [];
			},
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat1", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: "", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({
					listOpenPrs: async () => [openPrs()[0]],
					deleteRemoteBranch: async () => {
						throw new GitHubError("delete failed");
					},
				}),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.ok(result.completedMutations.some((line) => /Failed to delete remote branch feat1/.test(line)));
		}
	});
});
