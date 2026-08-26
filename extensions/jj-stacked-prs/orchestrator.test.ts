import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubError } from "../shared/github.ts";
import { buildNavigationComment, parseNavigationCommentEntries } from "../shared/stack/topology.ts";
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
import { renderInspect, renderPlan } from "./render.ts";
import { commit, fakeGithub, fakeJj, landed, openPrs, permissiveLock, ui } from "./test-fixtures.ts";
import type { BookmarkTarget, NavigationEntry, OpenPullRequest } from "./types.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function changeIdAt(index: number): string {
	return String.fromCharCode(97 + index).repeat(3);
}

function linearStack(size: number) {
	return Array.from({ length: size }, (_, index) =>
		commit(changeIdAt(index), `feat${index + 1}`, index === 0 ? "trunk" : `${changeIdAt(index - 1)}-commit`),
	);
}

function linearPrs(size: number): OpenPullRequest[] {
	return Array.from({ length: size }, (_, index) => ({
		number: 11 + index,
		headRef: `feat${index + 1}`,
		headCommitId: `${changeIdAt(index)}-commit`,
		baseRef: index === 0 ? "main" : `feat${index}`,
		title: `feat${index + 1}`,
		draft: true,
		url: `https://example/${11 + index}`,
		headOwner: "o",
	}));
}

function stackedJj(size: number) {
	const stack = linearStack(size);
	const bookmarks = stack.map((item) => ({ name: item.bookmarks[0], commitId: item.commitId }));
	return fakeJj({
		fetchStack: async () => stack,
		listLocalBookmarks: async () => bookmarks,
		listRemoteBookmarks: async () => bookmarks,
	});
}

function navEntry(prNumber: number, bookmark: string, status: NavigationEntry["status"] = "open"): NavigationEntry {
	return { prNumber, bookmark, base: "main", status };
}

function kstackComment(entries: readonly NavigationEntry[], id = 1) {
	return { id, body: buildNavigationComment(entries, "main"), user: "publisher" };
}

describe("inspect and plan", () => {
	it("inspects an injected stack that is independent of this repository's trunk", async () => {
		const model = await inspectStack(
			{ cwd: "/repo", top: "feat2" },
			{ run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }), ui: ui(), jj: fakeJj() },
		);
		assert.equal(model.trunk.commitId, "trunk");
		assert.equal(model.top, "feat2");
		assert.equal(model.stack.length, 2);
		assert.equal(model.blockers.length, 0);
	});

	it("reports one canonical change count when an empty working-copy change trails the top bookmark", async () => {
		const bottom = { ...commit("aaa", "unused"), bookmarks: [] };
		const top = commit("bbb", "feat2", "aaa-commit");
		const workingCopy = {
			...commit("ccc", "unused", "bbb-commit"),
			bookmarks: [],
			empty: true,
		};
		const jj = fakeJj({
			fetchStack: async () => [bottom, top, workingCopy],
			workingCopyChangeId: async () => "ccc",
			listLocalBookmarks: async () => [{ name: "feat2", commitId: "bbb-commit" }],
		});
		const deps = {
			run: async () => ({ kind: "ok" as const, code: 0, stdout: "", stderr: "" }),
			ui: ui(),
			jj,
			github: fakeGithub(),
		};
		const model = await inspectStack({ cwd: "/repo", top: "feat2" }, deps);
		assert.match(renderInspect(model), /3 jj changes → 1 PR slice/);

		const planned = await planStack({ cwd: "/repo", top: "feat2", remote: "origin" }, deps);
		assert.equal(planned.status, "ok");
		if (planned.status === "ok") assert.match(renderPlan(planned.plan), /3 jj changes → 1 PR slice/);
	});

	it("blocks a truncated publication plan", async () => {
		const planned = await planStack(
			{ cwd: "/repo", top: "feat2", remote: "origin", maxStack: 1 },
			{ run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }), ui: ui(), jj: fakeJj() },
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
					{
						run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
						ui: ui({ hasUI: false }),
						jj,
						github,
					},
				)
			).status,
			"blocked",
		);
		assert.equal(
			(
				await publishStack(
					{ cwd: "/repo", top: "feat2", remote: "origin" },
					{
						run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj: fakeJj(),
				github: fakeGithub({
					markPrReady: async (_repo, prNumber) => {
						ready.push(prNumber);
					},
				}),
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: {
					...ui({ hasUI: false }),
					confirm: async () => {
						throw new Error("the model tool must not prompt");
					},
				},
				jj,
				github: fakeGithub(),
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(jj.calls, ["push:feat1", "push:feat2"]);
	});

	it("replans under the lock, refuses a stale model-tool publication, and releases", async () => {
		const events: string[] = [];
		let remoteReads = 0;
		const jj = fakeJj({
			listRemoteBookmarks: async () => {
				remoteReads++;
				events.push(`plan-${remoteReads}`);
				return remoteReads === 1 ? [] : [{ name: "feat2", commitId: "changed" }];
			},
		});
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj,
				github: fakeGithub(),
				acquirePublicationLock: () => {
					events.push("acquire");
					return {
						ok: true,
						lock: {
							release: () => {
								events.push("release");
								return { ok: true };
							},
						},
					};
				},
			},
		);
		assert.equal(result.status, "stale");
		assert.deepEqual(events, ["plan-1", "acquire", "plan-2", "release"]);
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github,
				acquirePublicationLock: permissiveLock(),
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

	it("rejects metadata that does not conform to the repository template before the first remote mutation", async () => {
		const jj = fakeJj();
		let created = false;
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj,
				github: fakeGithub({
					createDraftPr: async () => {
						created = true;
						throw new Error("must not create");
					},
				}),
				loadRepositoryPrTemplate: () => ({
					path: ".github/pull_request_template.md",
					source: "### What changed?\n",
					requiresConventionalTitle: false,
					minimumDescriptionWords: undefined,
				}),
				generatePrMetadata: async () => ({
					title: "Add feature",
					body: "## Summary\n\n- Wrong shape.",
				}),
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "failed");
		assert.deepEqual(jj.calls, []);
		assert.equal(created, false);
		if (result.status === "failed") assert.match(result.error, /required template fragment/);
	});

	it("fails metadata generation before the first remote mutation", async () => {
		const jj = fakeJj();
		let created = false;
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: fakeJj({
					listRemoteBookmarks: async () => [
						{ name: "feat1", commitId: "aaa-commit" },
						{ name: "feat2", commitId: "bbb-commit" },
					],
				}),
				github,
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "stale");
	});

	it("skips comments when the authenticated user is unknown", async () => {
		let wrote = false;
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github: fakeGithub({
					getAuthenticatedUser: async () => undefined,
					createOrUpdateComment: async () => {
						wrote = true;
						return { id: 1 };
					},
				}),
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github: fakeGithub({
					createOrUpdateComment: async () => {
						throw new Error("comment API failed");
					},
				}),
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.ok(result.commentErrors?.some((error) => /comment API failed/.test(error)));
			assert.equal(result.publication.pullRequests.length, 2);
		}
	});

	it("stops later core actions and comment writes after the first conclusive failure", async () => {
		const jj = fakeJj({
			pushBookmark: async (_cwd, _remote, bookmark) => {
				jj.calls.push(`push:${bookmark}`);
				if (bookmark === "feat2") throw new Error("network");
			},
		});
		const github = fakeGithub();
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github,
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") {
			assert.ok(result.completedActions.some((action) => action.kind === "create-draft-pr"));
			assert.equal(result.failedAction.kind, "push-bookmark");
		}
		assert.equal(github.comments.length, 0);
	});

	it("is cancelled before an action starts and indeterminate after a mutator starts", async () => {
		const controller = new AbortController();
		const cancelled = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github,
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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

describe("publication lock", () => {
	it("blocks publication when the lock is held and reports the holder pid", async () => {
		const jj = fakeJj();
		const github = fakeGithub();
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj,
				github,
				acquirePublicationLock: () => ({
					ok: false,
					holder: { pid: 42, startedAt: "2025-06-01T00:00:00.000Z" },
				}),
			},
		);
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") {
			assert.ok(result.blockers.some((blocker) => blocker.code === "publication-locked"));
			assert.ok(result.blockers.some((blocker) => /pid 42/.test(blocker.message)));
		}
		// No remote mutation ran
		assert.deepEqual(jj.calls, []);
		assert.equal(github.comments.length, 0);
	});

	it("reports lock filesystem failures without remote mutation", async () => {
		const jj = fakeJj();
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj,
				github: fakeGithub(),
				acquirePublicationLock: () => {
					throw new Error("permission denied");
				},
			},
		);
		assert.deepEqual(result, {
			status: "failed",
			error: "Unable to acquire publication lock: Could not acquire the repository publication lock: permission denied",
		});
		assert.deepEqual(jj.calls, []);
	});

	it("keys the lock by the canonical common Git directory", async () => {
		let lockKey: string | undefined;
		const result = await publishStackFromTool(
			{ cwd: "/workspaces/task", top: "feat2", remote: "origin" },
			{
				run: async (argv, options) => {
					assert.deepEqual(argv, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
					assert.equal(options.cwd, "/workspaces/task");
					assert.equal(options.timeoutMs, 8_000);
					return { kind: "ok", code: 0, stdout: "/repo/.git\n", stderr: "" };
				},
				ui: ui({ hasUI: false }),
				jj: fakeJj(),
				github: fakeGithub(),
				realpath: (path) => `/canonical${path}`,
				acquirePublicationLock: (repositoryPath) => {
					lockKey = repositoryPath;
					return { ok: true, lock: { release: () => ({ ok: true }) } };
				},
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(lockKey, "/canonical/repo/.git");
	});

	it("warns when lock cleanup fails", async () => {
		const notifications: Array<{ message: string; level: string | undefined }> = [];
		const result = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: {
					...ui({ hasUI: false }),
					notify: (message, level) => notifications.push({ message, level }),
				},
				jj: fakeJj(),
				github: fakeGithub(),
				acquirePublicationLock: () => ({
					ok: true,
					lock: { release: () => ({ ok: false, error: "permission denied" }) },
				}),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(notifications, [
			{
				message:
					"Publication lock cleanup failed: permission denied. Remove the lock file manually if later publications block.",
				level: "warning",
			},
		]);
	});

	it("releases the lock on success and on publication failure", async () => {
		// Success path
		let released = false;
		const successResult = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj: fakeJj(),
				github: fakeGithub(),
				acquirePublicationLock: () => ({
					ok: true,
					lock: {
						release() {
							released = true;
							return { ok: true };
						},
					},
				}),
			},
		);
		assert.equal(successResult.status, "completed");
		assert.equal(released, true);

		// Failure path (applyPublication throws)
		let releasedOnFailure = false;
		const failureResult = await publishStackFromTool(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui({ hasUI: false }),
				jj: fakeJj({
					pushBookmark: async () => {
						throw new Error("push failure");
					},
				}),
				github: fakeGithub(),
				acquirePublicationLock: () => ({
					ok: true,
					lock: {
						release() {
							releasedOnFailure = true;
							return { ok: true };
						},
					},
				}),
			},
		);
		assert.equal(failureResult.status, "partial");
		assert.equal(releasedOnFailure, true);
	});
});

describe("navigation comment reconciliation concurrency", () => {
	it("caps concurrent comment reads at four", async () => {
		let activeReads = 0;
		let peakReads = 0;
		const result = await publishStack(
			{ cwd: "/repo", top: "feat6", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: stackedJj(6),
				github: fakeGithub({
					listOpenPrs: async () => linearPrs(6),
					getPrComments: async () => {
						activeReads += 1;
						peakReads = Math.max(peakReads, activeReads);
						await delay(20);
						activeReads -= 1;
						return [];
					},
				}),
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(peakReads, 4);
	});

	it("reduces prior navigation history in published order, not completion order", async () => {
		const firstLongest = [
			navEntry(101, "old-b1"),
			navEntry(102, "old-b2"),
			navEntry(103, "old-b3"),
			navEntry(104, "old-b4"),
			navEntry(11, "feat1", "draft"),
		];
		const tiedLater = [
			navEntry(201, "old-c1"),
			navEntry(202, "old-c2"),
			navEntry(203, "old-c3"),
			navEntry(204, "old-c4"),
			navEntry(11, "feat1", "draft"),
		];
		const shorter = [navEntry(301, "old-a1"), navEntry(11, "feat1", "draft")];
		const github = fakeGithub({
			listOpenPrs: async () => linearPrs(4),
			getPrComments: async (_repo, prNumber) => {
				if (prNumber === 11) {
					await delay(40);
					return [kstackComment(firstLongest)];
				}
				if (prNumber === 12) {
					await delay(5);
					return [kstackComment(shorter)];
				}
				if (prNumber === 13) {
					await delay(10);
					return [kstackComment(tiedLater)];
				}
				await delay(15);
				return [];
			},
		});
		const result = await publishStack(
			{ cwd: "/repo", top: "feat4", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: stackedJj(4),
				github,
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		const written = parseNavigationCommentEntries(github.comments[0] ?? "");
		assert.deepEqual(
			written.slice(0, 4).map((entry) => entry.bookmark),
			["old-b1", "old-b2", "old-b3", "old-b4"],
		);
	});

	it("finishes every comment and status read before serial comment writes", async () => {
		let outstandingReads = 0;
		let peakWrites = 0;
		let activeWrites = 0;
		let writeStartedDuringReads = false;
		const prior = [navEntry(101, "old-1"), navEntry(102, "old-2"), navEntry(11, "feat1", "draft")];
		const result = await publishStack(
			{ cwd: "/repo", top: "feat3", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: stackedJj(3),
				github: fakeGithub({
					listOpenPrs: async () => linearPrs(3),
					getPrComments: async () => {
						outstandingReads += 1;
						await delay(15);
						outstandingReads -= 1;
						return [kstackComment(prior)];
					},
					getPrStatus: async () => {
						outstandingReads += 1;
						await delay(15);
						outstandingReads -= 1;
						return "open";
					},
					createOrUpdateComment: async (input) => {
						if (outstandingReads > 0) writeStartedDuringReads = true;
						activeWrites += 1;
						peakWrites = Math.max(peakWrites, activeWrites);
						await delay(10);
						activeWrites -= 1;
						return { id: input.existingCommentId ?? 1 };
					},
				}),
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(writeStartedDuringReads, false);
		assert.equal(peakWrites, 1);
	});

	it("caps ancestor status reads at four and skips duplicates, merged, and active PRs", async () => {
		let activeStatus = 0;
		let peakStatus = 0;
		const statusCalls: number[] = [];
		const prior = [
			navEntry(101, "old-1"),
			navEntry(102, "old-2"),
			navEntry(103, "old-3"),
			navEntry(104, "old-4"),
			navEntry(105, "old-5"),
			navEntry(102, "old-2-dup"),
			navEntry(106, "old-merged", "merged"),
			navEntry(11, "feat1", "draft"),
			navEntry(12, "feat2", "draft"),
		];
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: stackedJj(2),
				github: fakeGithub({
					listOpenPrs: async () => linearPrs(2),
					getPrComments: async () => [kstackComment(prior)],
					getPrStatus: async (_repo, prNumber) => {
						statusCalls.push(prNumber);
						activeStatus += 1;
						peakStatus = Math.max(peakStatus, activeStatus);
						await delay(20);
						activeStatus -= 1;
						return "open";
					},
				}),
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(
			[...statusCalls].sort((left, right) => left - right),
			[101, 102, 103, 104, 105],
		);
		assert.equal(statusCalls.length, 5);
		assert.equal(peakStatus, 4);
	});

	it("stops comment writes after the first write failure", async () => {
		const attempted: number[] = [];
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: stackedJj(2),
				github: fakeGithub({
					listOpenPrs: async () => linearPrs(2),
					createOrUpdateComment: async (input) => {
						attempted.push(input.prNumber);
						throw new Error("comment write failed");
					},
				}),
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(attempted, [11]);
	});

	it("keeps successful writes and unknown ancestor status after independent read failures", async () => {
		const written: number[] = [];
		let writtenBody = "";
		const prior = [
			navEntry(101, "old-1"),
			navEntry(102, "old-2"),
			navEntry(11, "feat1", "draft"),
			navEntry(12, "feat2", "draft"),
		];
		const github = fakeGithub({
			listOpenPrs: async () => linearPrs(2),
			getPrComments: async (_repo, prNumber) => {
				if (prNumber === 12) throw new Error("comments unavailable");
				return [kstackComment(prior)];
			},
			getPrStatus: async (_repo, prNumber) => {
				if (prNumber === 101) throw new Error("status unavailable");
				return "open";
			},
			createOrUpdateComment: async (input) => {
				written.push(input.prNumber);
				writtenBody = input.body;
				return { id: 1 };
			},
		});
		const result = await publishStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: stackedJj(2),
				github,
				acquirePublicationLock: permissiveLock(),
			},
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(written, [11]);
		if (result.status === "completed") {
			assert.ok(result.commentErrors?.includes("PR #12: comments unavailable"));
			assert.ok(result.commentErrors?.includes("status unavailable"));
		}
		const writtenEntries = parseNavigationCommentEntries(writtenBody);
		assert.equal(writtenEntries.find((entry) => entry.prNumber === 101)?.status, "unknown");
		assert.equal(writtenEntries.find((entry) => entry.prNumber === 102)?.status, "open");
	});
});

describe("sync and advance", () => {
	it("rebases only the selected stack after a confirmed fetch", async () => {
		const jj = fakeJj();
		const result = await syncStack(
			{ cwd: "/repo", top: "feat2", remote: "origin" },
			{ run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }), ui: ui(), jj, github: fakeGithub() },
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
			{ run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }), ui: ui(), jj, github: fakeGithub() },
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj: fakeJj(),
				github: fakeGithub(),
				realpath: (path) => path,
				acquirePublicationLock: permissiveLock(),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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

	it("rebases the selected stack's empty working-copy child onto refreshed trunk", async () => {
		const stack = [commit("aaa", "feat1")];
		const jj = fakeJj({
			fetchStack: async () => stack,
			resolveRevset: async (_cwd, revset) => (revset === "trunk()" ? "trunk" : "aaa-commit"),
			listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
			workingCopyChangeId: async () => "wc-change",
			workingCopyStatus: async () => ({
				commitId: "wc-commit",
				empty: true,
				bookmarked: false,
				parentCommitIds: ["aaa-commit"],
			}),
			isAncestor: async (_cwd, ancestor, descendant) => ancestor.startsWith("merge-") && descendant === "trunk",
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat1", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => [openPrs()[0]] }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "completed");
		assert.ok(jj.calls.includes("rebase-wc:trunk"));
		if (result.status === "completed") {
			assert.ok(result.completedMutations.includes("Rebased the empty working copy onto the refreshed trunk"));
		}
	});

	it("rebases an empty automation checkpoint bookmarked as the selected top", async () => {
		const stack = [commit("aaa", "feat1")];
		let statusReads = 0;
		let changeIdReads = 0;
		const jj = fakeJj({
			fetchStack: async () => stack,
			resolveRevset: async (_cwd, revset) => (revset === "trunk()" ? "trunk" : "aaa-commit"),
			listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
			workingCopyChangeId: async () => {
				changeIdReads++;
				return changeIdReads <= 2 ? "checkpoint-change" : "replacement-change";
			},
			workingCopyStatus: async () => {
				statusReads++;
				return statusReads === 1
					? { commitId: "aaa-commit", empty: true, bookmarked: true, parentCommitIds: ["parent-commit"] }
					: {
							commitId: "replacement-checkpoint",
							empty: true,
							bookmarked: false,
							parentCommitIds: ["trunk"],
						};
			},
			isAncestor: async (_cwd, ancestor) => ancestor.startsWith("merge-"),
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat1", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => [openPrs()[0]] }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "completed");
		assert.ok(jj.calls.includes("rebase-wc:trunk"));
	});

	it("reports a pre-land working-copy inspection failure without blocking landing", async () => {
		const stack = [commit("aaa", "feat1")];
		const jj = fakeJj({
			fetchStack: async () => stack,
			listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
			workingCopyStatus: async () => {
				throw new Error("template error");
			},
			isAncestor: async (_cwd, ancestor, descendant) => ancestor.startsWith("merge-") && descendant === "trunk",
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat1", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => [openPrs()[0]] }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.ok(
				result.completedMutations.includes("Could not inspect the working copy before landing: template error"),
			);
		}
	});

	it("leaves an empty working copy with intervening changes in place after the final land", async () => {
		const stack = [commit("aaa", "feat1")];
		const jj = fakeJj({
			fetchStack: async () => stack,
			resolveRevset: async (_cwd, revset) => (revset === "trunk()" ? "trunk" : "aaa-commit"),
			listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
			workingCopyChangeId: async () => "unrelated-change",
			workingCopyStatus: async () => ({
				commitId: "unrelated-commit",
				empty: true,
				bookmarked: false,
				parentCommitIds: ["intervening-commit"],
			}),
			isAncestor: async (_cwd, ancestor, descendant) => ancestor.startsWith("merge-") && descendant === "trunk",
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat1", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => [openPrs()[0]] }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(
			jj.calls.some((call) => call.startsWith("rebase-wc:")),
			false,
		);
	});

	it("leaves a bookmarked or non-empty working copy in place after the final land", async () => {
		const stack = [commit("aaa", "feat1")];
		const jj = fakeJj({
			fetchStack: async () => stack,
			listLocalBookmarks: async () => [{ name: "feat1", commitId: "aaa-commit" }],
			workingCopyStatus: async () => ({
				commitId: "wc-commit",
				empty: false,
				bookmarked: true,
				parentCommitIds: ["aaa-commit"],
			}),
			isAncestor: async (_cwd, ancestor) => ancestor.startsWith("merge-"),
		});
		const result = await landStack(
			{ cwd: "/repo", top: "feat1", remote: "origin", readiness: "watch", method: "squash" },
			{
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => [openPrs()[0]] }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "completed");
		assert.equal(
			jj.calls.some((call) => call.startsWith("rebase-wc:")),
			false,
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
						remainingRefs: [],
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
				ui: ui(),
				jj,
				github: fakeGithub({ listOpenPrs: async () => openPrs() }),
				landPr: async () => ({ handled: true, outcome: landed(11, "aaa-commit") }),
			},
		);
		assert.equal(result.status, "partial");
		if (result.status === "partial") {
			assert.match(result.error, /not an ancestor/);
			assert.deepEqual(result.remainingRefs, ["feat2"]);
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
				run: async () => ({ kind: "ok", code: 0, stdout: ".\n", stderr: "" }),
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
			assert.ok(result.warnings?.some((line) => /Failed to delete remote branch feat1/.test(line)));
			assert.equal(
				result.completedMutations.some((line) => /Failed to delete remote branch/.test(line)),
				false,
			);
		}
	});
});
