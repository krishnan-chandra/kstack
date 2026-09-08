import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { isString } from "../shared/validation.ts";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import { JjBackend } from "../shared/vcs/jj-backend.ts";
import {
	applyTriageGuardrails,
	fetchPRState,
	loadPersistedState,
	parseTriage,
	persistPath,
	runCleanup,
	savePersistedState,
	summarizeTriage,
} from "./autopilot-operations.ts";
import { DEFAULT_AUTOPILOT_MODELS } from "./config.ts";
import { attachFailedLogs } from "./github.ts";
import type { GHPrJson } from "./github-parse.ts";
import {
	buildFixerTask,
	buildPRState,
	buildTriagerTask,
	describeBlockers,
	isCodeReady,
	isMergeReady,
	pickModel,
} from "./pr-state.ts";
import { type AutopilotPersistedState, type CheckRun, type ExecFn, LIMITS, type ReviewThread } from "./types.ts";

function makePr(overrides: Partial<GHPrJson> = {}): GHPrJson {
	return {
		number: 42,
		title: "Fix the thing",
		state: "open",
		isDraft: false,
		mergeable: "true",
		mergeStateStatus: "CLEAN",
		headRefName: "kstack/fix-thing",
		baseRefName: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		commits: [{ oid: "0123456789abcdef0123456789abcdef01234567" }],
		...overrides,
	};
}

function makeCheck(name: string, conclusion: CheckRun["conclusion"], status: CheckRun["status"] = "success"): CheckRun {
	return { name, conclusion, status: conclusion === "pending" || conclusion === null ? "pending" : status };
}

function failedActionsCheck(name: string, runId: string): CheckRun {
	return { name, status: "failure", conclusion: "failure", runId };
}

function makeThread(id: string, body = "Looks good to me"): ReviewThread {
	return {
		id,
		commenter: "reviewer",
		body,
		path: "src/index.ts",
		line: 10,
		source: "review-thread",
		replyToId: 1,
		version: `${id}:${body}`,
	};
}

/**
 * Build a mock `git worktree list --porcelain -z` record for one worktree.
 *
 * The porcelain null-delimited format is:
 *   worktree <path>\0HEAD <sha>\0branch refs/heads/<name>\0\0
 *
 * The double null at the end terminates the record. The SHA must be exactly
 * 40 hex characters (the test helper uses `"a".repeat(40)` as the dummy value).
 */
function makePorcelainRecord(path: string, branch: string, head: string = "a".repeat(40)): string {
	return `worktree ${path}\0HEAD ${head}\0branch refs/heads/${branch}\0\0`;
}

describe("pr-autopilot state machine", () => {
	describe("buildPRState", () => {
		it("maps GitHub JSON to PRState", () => {
			const state = buildPRState(makePr(), [makeThread("1")], [makeCheck("lint", "success")], null);
			assert.equal(state.number, 42);
			assert.equal(state.headSha, "0123456789abcdef0123456789abcdef01234567");
			assert.equal(state.baseRef, "main");
			assert.equal(state.headRef, "kstack/fix-thing");
			assert.equal(state.mergeable, "mergeable");
			assert.equal(state.mergeStateStatus, "CLEAN");
			assert.equal(state.hasUnresolvedThreads, true);
		});

		it("translates mergeable=false to conflicting", () => {
			const state = buildPRState(makePr({ mergeable: "false", mergeStateStatus: "DIRTY" }), [], [], null);
			assert.equal(state.mergeable, "conflicting");
		});

		it("does not treat an empty thread list as unresolved", () => {
			const state = buildPRState(makePr(), [], [makeCheck("lint", "success")], null);
			assert.equal(state.hasUnresolvedThreads, false);
		});

		it("preserves verified head SHA when it matches", () => {
			const sha = "0123456789abcdef0123456789abcdef01234567";
			const state = buildPRState(makePr({ headSha: sha }), [], [], sha);
			assert.equal(state.verifiedHeadSha, sha);
		});

		it("clears verified head SHA when it differs", () => {
			const state = buildPRState(makePr({ headSha: "aaa" }), [], [], "bbb");
			assert.equal(state.verifiedHeadSha, null);
		});
	});

	describe("isMergeReady / isCodeReady", () => {
		it("returns true when green, no threads, CLEAN, not draft, and verified at the exact head", () => {
			const sha = "0123456789abcdef0123456789abcdef01234567";
			const state = buildPRState(
				makePr({ isDraft: false, mergeable: "true", mergeStateStatus: "CLEAN", headSha: sha }),
				[],
				[makeCheck("lint", "success"), makeCheck("test", "skipped")],
				sha,
			);
			assert.equal(isMergeReady(state), true);
			assert.equal(isCodeReady(state), true);
		});

		it("does not declare an otherwise-ready unverified head merge-ready", () => {
			const state = buildPRState(makePr(), [], [makeCheck("lint", "success")], null);
			assert.equal(isCodeReady(state), true);
			assert.equal(isMergeReady(state), false);
		});

		it("treats drafts as code-ready but not merge-ready", () => {
			const state = buildPRState(
				makePr({ isDraft: true, mergeable: "true", mergeStateStatus: "DRAFT" }),
				[],
				[makeCheck("lint", "success")],
				null,
			);
			assert.equal(isCodeReady(state), true);
			assert.equal(isMergeReady(state), false);
		});

		it("returns false when there are unresolved threads", () => {
			const state = buildPRState(
				makePr({ mergeable: "true" }),
				[makeThread("1")],
				[makeCheck("lint", "success")],
				null,
			);
			assert.equal(isMergeReady(state), false);
		});

		it("returns false when checks are failing", () => {
			const state = buildPRState(makePr({ mergeable: "true" }), [], [makeCheck("lint", "failure", "failure")], null);
			assert.equal(isMergeReady(state), false);
		});

		it("treats cancelled checks as actionable failures", () => {
			const state = buildPRState(makePr(), [], [makeCheck("build", "cancelled", "cancelled")], null);
			assert.equal(isCodeReady(state), false);
			assert.match(describeBlockers(state), /failing check/);
		});

		it("returns false when checks are still pending", () => {
			const state = buildPRState(
				makePr({ mergeable: "true", mergeStateStatus: "UNKNOWN" }),
				[],
				[makeCheck("lint", null, "pending")],
				null,
			);
			assert.equal(isMergeReady(state), false);
			assert.equal(isCodeReady(state), false);
		});

		it("returns false when conflicts", () => {
			const state = buildPRState(
				makePr({ mergeable: "false", mergeStateStatus: "DIRTY" }),
				[],
				[makeCheck("lint", "success")],
				null,
			);
			assert.equal(isMergeReady(state), false);
		});

		it("returns false when behind base", () => {
			const state = buildPRState(makePr({ mergeStateStatus: "BEHIND" }), [], [makeCheck("lint", "success")], null);
			assert.equal(isMergeReady(state), false);
		});
	});

	describe("describeBlockers", () => {
		it("lists all blockers", () => {
			const state = buildPRState(
				makePr({ isDraft: true, mergeable: "false", mergeStateStatus: "DIRTY" }),
				[makeThread("1")],
				[makeCheck("lint", "failure", "failure")],
				null,
			);
			const desc = describeBlockers(state);
			assert.match(desc, /draft/);
			assert.match(desc, /conflicts/);
			assert.match(desc, /unresolved threads/);
			assert.match(desc, /failing check/);
		});

		it("names pending checks", () => {
			const state = buildPRState(
				makePr({ mergeStateStatus: "UNKNOWN" }),
				[],
				[makeCheck("lint", null, "pending")],
				null,
			);
			assert.match(describeBlockers(state), /pending/);
		});

		it("counts only unresolved review threads", () => {
			const state = buildPRState(
				makePr(),
				[
					makeThread("review-thread-1"),
					{
						id: "issue-comment-1",
						commenter: "reviewer",
						body: "FYI",
						source: "issue-comment",
						version: "issue-comment-1:FYI",
					},
				],
				[],
				null,
			);
			assert.match(describeBlockers(state), /unresolved threads \(1\)/);
		});
	});

	describe("cleanup semantics", () => {
		function gitResponses(responses: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
			const calls: string[] = [];
			const exec: ExecFn = async (_command, args) => {
				const key = args.join(" ");
				calls.push(key);
				const response = responses[key] ?? {};
				return { code: response.code ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
			};
			return { exec, calls };
		}

		it("is an explicit no-op for jj without asking to remove a Git worktree", async () => {
			let confirmed = false;
			const notices: string[] = [];
			const exec: ExecFn = async () => {
				throw new Error("jj cleanup must not execute a VCS command");
			};
			const cleaned = await runCleanup(
				new JjBackend(exec),
				"/repo",
				async () => {
					confirmed = true;
					return true;
				},
				(message) => notices.push(message),
			);
			assert.equal(cleaned, true);
			assert.equal(confirmed, false);
			assert.match(notices.join("\n"), /no managed worktrees/);
		});

		it("does not confirm or remove a non-kstack Git branch", async () => {
			let confirmed = false;
			const notices: Array<{ message: string; level: string }> = [];
			const { exec, calls } = gitResponses({
				"branch --show-current": { stdout: "main\n" },
			});
			const cleaned = await runCleanup(
				new GitBackend(exec),
				"/repo",
				async () => {
					confirmed = true;
					return true;
				},
				(message, level) => notices.push({ message, level }),
			);
			assert.equal(cleaned, true);
			assert.equal(confirmed, false);
			assert.equal(
				calls.some((call) => call.includes("worktree remove") || call.startsWith("branch -d")),
				false,
			);
			assert.match(notices.map((notice) => notice.message).join("\n"), /not a managed kstack worktree/);
		});

		it("returns false and does not remove when confirmation is declined", async () => {
			const { exec, calls } = gitResponses({
				"branch --show-current": { stdout: "kstack/fix-thing\n" },
			});
			const cleaned = await runCleanup(
				new GitBackend(exec),
				"/repo",
				async () => false,
				() => {},
			);
			assert.equal(cleaned, false);
			assert.equal(
				calls.some((call) => call.includes("worktree remove") || call.startsWith("branch -d")),
				false,
			);
		});

		it("returns false and emits an error when worktree removal fails", async () => {
			const notices: Array<{ message: string; level: string }> = [];
			const { exec, calls } = gitResponses({
				"branch --show-current": { stdout: "kstack/fix-thing\n" },
				"rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
				"worktree list --porcelain -z": {
					stdout: makePorcelainRecord("/repo", "kstack/fix-thing"),
				},
				"status --porcelain=v1 --untracked-files=all": {},
				"worktree remove /repo": { code: 1, stderr: "worktree locked\n" },
			});
			const cleaned = await runCleanup(
				new GitBackend(exec, { managedRoot: "/", realpath: (path) => path }),
				"/repo",
				async () => true,
				(message, level) => notices.push({ message, level }),
			);
			assert.equal(cleaned, false);
			assert.equal(
				calls.some((call) => call.startsWith("branch -d")),
				false,
			);
			assert.deepEqual(notices, [
				{ message: "Worktree removal failed: worktree locked. You may need to remove it manually.", level: "error" },
			]);
		});

		it("returns true and emits warning plus completion after a branch-deletion warning", async () => {
			const notices: Array<{ message: string; level: string }> = [];
			const { exec } = gitResponses({
				"branch --show-current": { stdout: "kstack/fix-thing\n" },
				"rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
				"worktree list --porcelain -z": {
					stdout: makePorcelainRecord("/repo", "kstack/fix-thing"),
				},
				"status --porcelain=v1 --untracked-files=all": {},
				"worktree remove /repo": {},
				"branch -d kstack/fix-thing": { code: 1, stderr: "not fully merged\n" },
			});
			const cleaned = await runCleanup(
				new GitBackend(exec, { managedRoot: "/", realpath: (path) => path }),
				"/repo",
				async () => true,
				(message, level) => notices.push({ message, level }),
			);
			assert.equal(cleaned, true);
			assert.deepEqual(notices, [
				{ message: "Branch deletion warning: not fully merged", level: "warning" },
				{
					message: "Managed worktree and branch removed. To archive the linked Pi session, run: /session-archive",
					level: "info",
				},
			]);
		});
	});

	describe("failed log hydration", () => {
		function logExec(
			responseForRun: (runId: string, call: number) => { code: number; stdout: string; stderr: string },
		) {
			const calls: string[] = [];
			const exec: ExecFn = async (command, args) => {
				const call = `${command} ${args.join(" ")}`;
				calls.push(call);
				const runId = args[2] ?? "";
				return responseForRun(runId, calls.length);
			};
			return { calls, exec };
		}

		it("fetches one failed log for six checks sharing a run", async () => {
			const checks = Array.from({ length: 6 }, (_, index) => failedActionsCheck(`job-${index + 1}`, "123"));
			const { calls, exec } = logExec(() => ({ code: 0, stdout: "shared run failure\n", stderr: "" }));

			const hydrated = await attachFailedLogs(exec, "/repo", checks, 3);

			assert.deepEqual(calls, ["gh run view 123 --log-failed"]);
			assert.deepEqual(
				hydrated.map((check) => check.logExcerpt),
				Array.from({ length: 6 }, () => "shared run failure"),
			);
			assert.deepEqual(
				hydrated.map((check) => check.name),
				checks.map((check) => check.name),
			);
		});

		it("fetches one failed log for each of two distinct runs", async () => {
			const checks = [
				failedActionsCheck("build", "123"),
				failedActionsCheck("unit", "456"),
				failedActionsCheck("integration", "123"),
				failedActionsCheck("lint", "456"),
			];
			const { calls, exec } = logExec((runId) => ({ code: 0, stdout: `failure from ${runId}\n`, stderr: "" }));

			const hydrated = await attachFailedLogs(exec, "/repo", checks, 2);

			assert.deepEqual(calls, ["gh run view 123 --log-failed", "gh run view 456 --log-failed"]);
			assert.deepEqual(
				hydrated.map((check) => check.logExcerpt),
				["failure from 123", "failure from 456", "failure from 123", "failure from 456"],
			);
		});

		for (const response of [
			{ label: "failed", result: { code: 1, stdout: "", stderr: "not found" } },
			{ label: "empty", result: { code: 0, stdout: "  \n", stderr: "" } },
		]) {
			it(`does not retry a ${response.label} shared failed-log request`, async () => {
				const checks = [failedActionsCheck("build", "123"), failedActionsCheck("test", "123")];
				const { calls, exec } = logExec(() => response.result);

				const hydrated = await attachFailedLogs(exec, "/repo", checks, 2);

				assert.deepEqual(calls, ["gh run view 123 --log-failed"]);
				assert.deepEqual(hydrated, checks);
			});
		}

		it("leaves nonfailing and non-Actions checks unchanged without fetching logs", async () => {
			const checks: CheckRun[] = [
				makeCheck("green", "success"),
				makeCheck("external failure", "failure", "failure"),
				{ name: "cancelled run", runId: "123", conclusion: "cancelled", status: "cancelled" },
			];
			const { calls, exec } = logExec(() => ({ code: 0, stdout: "must not fetch", stderr: "" }));

			const hydrated = await attachFailedLogs(exec, "/repo", checks, 2);

			assert.deepEqual(calls, []);
			assert.strictEqual(hydrated, checks);
		});

		it("bounds concurrent failed-log requests across distinct runs", async () => {
			const checks = ["1", "2", "3", "4"].map((runId) => failedActionsCheck(`job-${runId}`, runId));
			let active = 0;
			let maxActive = 0;
			const exec: ExecFn = async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return { code: 0, stdout: "failed\n", stderr: "" };
			};

			await attachFailedLogs(exec, "/repo", checks, 2);

			assert.equal(maxActive, 2);
		});

		it("caps a hydrated failed log while retaining its tail", async () => {
			const marker = "LATEST-FAILURE-MARKER";
			const { exec } = logExec(() => ({
				code: 0,
				stdout: `${"x".repeat(LIMITS.logExcerptBytes * 2)}${marker}\n`,
				stderr: "",
			}));

			const [hydrated] = await attachFailedLogs(exec, "/repo", [failedActionsCheck("build", "123")], 1);

			assert.ok(hydrated.logExcerpt);
			assert.ok(Buffer.byteLength(hydrated.logExcerpt, "utf8") <= LIMITS.logExcerptBytes);
			assert.ok(hydrated.logExcerpt.endsWith(marker));
		});

		it("fetches a fresh failed log on each hydration invocation", async () => {
			const checks = [failedActionsCheck("build", "123")];
			const { calls, exec } = logExec((_runId, call) => ({ code: 0, stdout: `attempt-${call}\n`, stderr: "" }));

			const first = await attachFailedLogs(exec, "/repo", checks, 1);
			const second = await attachFailedLogs(exec, "/repo", checks, 1);

			assert.equal(first[0].logExcerpt, "attempt-1");
			assert.equal(second[0].logExcerpt, "attempt-2");
			assert.equal(calls.length, 2);
		});
	});

	describe("required GitHub state", () => {
		it("fetches failed-check metadata without downloading logs", async () => {
			const calls: string[] = [];
			const exec: ExecFn = async (command, args) => {
				const call = `${command} ${args.join(" ")}`;
				calls.push(call);
				if (args[0] === "pr" && args[1] === "view") {
					return { code: 0, stdout: JSON.stringify(makePr()), stderr: "" };
				}
				if (args[0] === "api" && args[1] === "graphql") {
					return {
						code: 0,
						stdout: JSON.stringify({
							data: {
								repository: {
									pullRequest: {
										reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
									},
								},
							},
						}),
						stderr: "",
					};
				}
				if (args[0] === "api" && args[1]?.includes("/issues/42/comments")) {
					return { code: 0, stdout: "[]", stderr: "" };
				}
				if (args[0] === "pr" && args[1] === "checks") {
					return {
						code: 0,
						stdout: JSON.stringify([
							{
								name: "build",
								state: "FAILURE",
								bucket: "fail",
								link: "https://github.com/owner/repo/actions/runs/123",
							},
						]),
						stderr: "",
					};
				}
				if (args[0] === "run" && args[1] === "view") {
					return { code: 0, stdout: "should not be fetched\n", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: `unexpected command: ${call}` };
			};

			const result = await fetchPRState(
				exec,
				"/repo",
				42,
				null,
				{ handled: [], pendingReviewReplies: [], legacyPendingReplyIds: [] },
				"owner/repo",
			);

			if (isString(result)) throw new Error(result);
			assert.equal(result.checks[0]?.runId, "123");
			assert.equal(result.checks[0]?.logExcerpt, undefined);
			assert.deepEqual(
				calls.filter((call) => call.startsWith("gh run view")),
				[],
			);
		});

		it("does not turn failed auxiliary fetches into empty successful state", async () => {
			const pr = makePr();
			const exec: ExecFn = async (command, args) => {
				if (command === "gh" && args[0] === "pr" && args[1] === "view") {
					return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "network unavailable" };
			};
			const result = await fetchPRState(
				exec,
				"/repo",
				42,
				null,
				{
					handled: [],
					pendingReviewReplies: [],
					legacyPendingReplyIds: [],
				},
				"owner/repo",
			);
			assert.match(String(result), /Could not fetch/);
		});
	});

	describe("pickModel", () => {
		it("picks one model from the pool using the injected random source", () => {
			const models = DEFAULT_AUTOPILOT_MODELS;
			assert.equal(pickModel(models, () => 0).label, "luna");
			assert.equal(pickModel(models, () => 0.32).label, "luna");
			assert.equal(pickModel(models, () => 1 / 3).label, "glm");
			assert.equal(pickModel(models, () => 0.99).label, "deepseek");
		});
	});

	describe("persisted state", () => {
		async function withAgentDir(fn: (agentDir: string) => Promise<void>): Promise<void> {
			const agentDir = await mkdtemp(join(tmpdir(), "kstack-autopilot-state-"));
			const previous = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			try {
				await fn(agentDir);
			} finally {
				if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previous;
				await rm(agentDir, { recursive: true, force: true });
			}
		}

		function blockedDiagnostic(loaded: Awaited<ReturnType<typeof loadPersistedState>>): string {
			assert.equal(loaded.kind, "blocked");
			return loaded.kind === "blocked" ? loaded.reviewMutationBlocker : "";
		}

		function persistedState(repoKey: string, prNumber = 5): AutopilotPersistedState {
			return {
				schemaVersion: 3,
				repoKey,
				prNumber,
				headSha: "abc",
				handled: [
					{
						id: "thread-1",
						source: "review-thread",
						version: "a".repeat(64),
						decision: "fix",
					},
				],
				pendingReviewReplies: [{ id: "thread-2", version: "b".repeat(64) }],
				legacyPendingReplyIds: [],
				flakeRetried: ["check@sha"],
				flakeRunRetries: [{ runId: "123", headSha: "abc" }],
			};
		}

		it("uses distinct paths for the same PR in different repositories", () => {
			assert.notEqual(persistPath("repo-a", 5), persistPath("repo-b", 5));
		});

		it("round-trips schema 3 with private permissions", async () => {
			await withAgentDir(async () => {
				const repoKey = `test-${process.pid}-${Date.now()}`;
				const path = persistPath(repoKey, 5);
				const expected = persistedState(repoKey);
				await savePersistedState(expected);
				const loaded = await loadPersistedState(repoKey, 5);
				assert.deepEqual(loaded, { kind: "ready", state: expected });
				assert.deepEqual(
					(await readdir(dirname(path))).filter((file) => file.endsWith(".tmp")),
					[],
				);
				if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
			});
		});

		it("migrates legacy worktree-keyed state to the repository key", async () => {
			await withAgentDir(async () => {
				const legacyRepoKey = "legacykey1";
				const repoKey = "newkey000001";
				const legacy = persistedState(legacyRepoKey);
				const legacyPath = persistPath(legacyRepoKey, 5);
				const newPath = persistPath(repoKey, 5);
				await savePersistedState(legacy);
				const legacyRaw = await readFile(legacyPath, "utf8");

				const loaded = await loadPersistedState(repoKey, 5, legacyRepoKey);

				assert.equal(loaded.kind, "ready");
				assert.deepEqual(loaded.state, { ...legacy, repoKey });
				if (loaded.kind === "ready") assert.match(loaded.migrationNote ?? "", /worktree key to the repository key/);
				assert.equal(await readFile(newPath, "utf8"), JSON.stringify({ ...legacy, repoKey }));
				assert.equal(await readFile(legacyPath, "utf8"), legacyRaw);
			});
		});

		it("prefers existing repository-keyed state over legacy state", async () => {
			await withAgentDir(async () => {
				const legacyRepoKey = "legacykey1";
				const repoKey = "newkey000001";
				await savePersistedState({ ...persistedState(legacyRepoKey), headSha: "legacy" });
				const repositoryState = { ...persistedState(repoKey), headSha: "repository" };
				await savePersistedState(repositoryState);

				const loaded = await loadPersistedState(repoKey, 5, legacyRepoKey);

				assert.deepEqual(loaded.state, repositoryState);
				if (loaded.kind === "ready") assert.equal(loaded.migrationNote, undefined);
			});
		});

		it("does not fall back to legacy state when the repository-keyed file is malformed", async () => {
			await withAgentDir(async () => {
				const legacyRepoKey = "legacykey1";
				const repoKey = "newkey000001";
				await savePersistedState(persistedState(legacyRepoKey));
				await writeFile(persistPath(repoKey, 5), "not json", { mode: 0o600 });

				const loaded = await loadPersistedState(repoKey, 5, legacyRepoKey);

				assert.equal(loaded.kind, "blocked");
			});
		});

		it("surfaces a corrupt legacy file instead of ignoring it", async () => {
			await withAgentDir(async () => {
				const legacyRepoKey = "legacykey1";
				const repoKey = "newkey000001";
				const legacyPath = persistPath(legacyRepoKey, 5);
				await mkdir(dirname(legacyPath), { recursive: true });
				await writeFile(legacyPath, "not json", { mode: 0o600 });

				const loaded = await loadPersistedState(repoKey, 5, legacyRepoKey);

				assert.equal(loaded.kind, "blocked");
			});
		});

		it("keeps the previous state visible until its replacement is ready", async () => {
			await withAgentDir(async () => {
				const repoKey = `atomic-${process.pid}-${Date.now()}`;
				const path = persistPath(repoKey, 5);
				const previous = persistedState(repoKey);
				await savePersistedState(previous);
				const replacement = { ...previous, headSha: "second", handled: [] };
				const replacementWithProbe = {
					...replacement,
					toJSON() {
						assert.equal(readFileSync(path, "utf8"), JSON.stringify(previous));
						return replacement;
					},
				};
				await savePersistedState(replacementWithProbe);
				assert.deepEqual(await loadPersistedState(repoKey, 5), { kind: "ready", state: replacement });
			});
		});

		it("migrates schema 1 review handling and retains legacy retry evidence", async () => {
			await withAgentDir(async () => {
				const repoKey = "legacy";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(
					path,
					JSON.stringify({
						repoKey,
						prNumber: 7,
						headSha: "old",
						handledThreadIds: ["handled-before"],
						repliedThreadIds: ["pending-before"],
						flakeRetried: ["check@sha", "check@sha"],
					}),
				);
				const migrated = await loadPersistedState(repoKey, 7);
				assert.equal(migrated.kind, "ready");
				assert.equal(migrated.state.schemaVersion, 3);
				assert.deepEqual(migrated.state.handled, []);
				assert.deepEqual(migrated.state.legacyPendingReplyIds, ["pending-before"]);
				assert.deepEqual(migrated.state.flakeRetried, ["check@sha"]);
				assert.deepEqual(migrated.state.flakeRunRetries, []);
				if (migrated.kind === "ready") assert.match(migrated.migrationNote ?? "", /every matching Actions run/);
				await savePersistedState(migrated.state);
				assert.equal((await loadPersistedState(repoKey, 7)).kind, "ready");
			});
		});

		it("migrates schema 2 without reinterpreting versioned review state", async () => {
			await withAgentDir(async () => {
				const repoKey = "schema-2";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(
					path,
					JSON.stringify({
						schemaVersion: 2,
						repoKey,
						prNumber: 7,
						headSha: "old",
						handled: [
							{
								id: "thread-1",
								source: "review-thread",
								version: "a".repeat(64),
								decision: "fix",
							},
						],
						pendingReviewReplies: [{ id: "thread-2", version: "b".repeat(64) }],
						legacyPendingReplyIds: ["thread-3"],
						flakeRetried: ["test@old"],
					}),
				);
				const migrated = await loadPersistedState(repoKey, 7);
				assert.equal(migrated.kind, "ready");
				assert.equal(migrated.state.schemaVersion, 3);
				assert.deepEqual(migrated.state.handled, [
					{ id: "thread-1", source: "review-thread", version: "a".repeat(64), decision: "fix" },
				]);
				assert.deepEqual(migrated.state.pendingReviewReplies, [{ id: "thread-2", version: "b".repeat(64) }]);
				assert.deepEqual(migrated.state.legacyPendingReplyIds, ["thread-3"]);
				assert.deepEqual(migrated.state.flakeRetried, ["test@old"]);
				assert.deepEqual(migrated.state.flakeRunRetries, []);
				if (migrated.kind === "ready") assert.match(migrated.migrationNote ?? "", /schema 2/);
			});
		});

		it("deduplicates exact schema 3 run retry records", async () => {
			await withAgentDir(async () => {
				const repoKey = "deduplicated";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				const state = persistedState(repoKey, 7);
				await writeFile(
					path,
					JSON.stringify({
						...state,
						flakeRunRetries: [
							{ runId: "123", headSha: "abc" },
							{ runId: "123", headSha: "abc" },
							{ runId: "123", headSha: "another-head" },
						],
					}),
				);
				const loaded = await loadPersistedState(repoKey, 7);
				assert.deepEqual(loaded.state.flakeRunRetries, [
					{ runId: "123", headSha: "abc" },
					{ runId: "123", headSha: "another-head" },
				]);
			});
		});

		it("blocks legacy state whose repository or PR identity does not match its path", async () => {
			await withAgentDir(async () => {
				const repoKey = "expected-repo";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				for (const identity of [
					{ repoKey: "another-repo", prNumber: 7 },
					{ repoKey, prNumber: 8 },
				]) {
					await writeFile(
						path,
						JSON.stringify({
							...identity,
							headSha: "old",
							handledThreadIds: ["handled-before"],
							repliedThreadIds: ["pending-before"],
							flakeRetried: [],
						}),
					);
					const loaded = await loadPersistedState(repoKey, 7);
					assert.equal(loaded.kind, "blocked");
					assert.match(blockedDiagnostic(loaded), /identity/);
				}
			});
		});

		it("blocks malformed and future schemas with bounded diagnostics", async () => {
			await withAgentDir(async () => {
				const repoKey = "invalid";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				for (const raw of [
					"not json",
					JSON.stringify({ schemaVersion: 99 }),
					JSON.stringify({
						schemaVersion: 3,
						repoKey,
						prNumber: 7,
						headSha: "abc",
						handled: [{ id: "thread-1", source: "review-thread", version: "not-a-hash", decision: "fix" }],
						pendingReviewReplies: [],
						legacyPendingReplyIds: [],
						flakeRetried: [],
						flakeRunRetries: [],
					}),
					JSON.stringify({
						schemaVersion: 3,
						repoKey,
						prNumber: 7,
						headSha: "abc",
						handled: [],
						pendingReviewReplies: [],
						legacyPendingReplyIds: [],
						flakeRetried: [],
						flakeRunRetries: [{ runId: "", headSha: "abc" }],
					}),
				]) {
					await writeFile(path, raw);
					const loaded = await loadPersistedState(repoKey, 7);
					const diagnostic = blockedDiagnostic(loaded);
					assert.match(diagnostic, /needs inspection/);
					assert.ok(diagnostic.length < 300);
				}
			});
		});

		it("refuses symlink reads and replaces a state symlink without writing through it", async () => {
			await withAgentDir(async (agentDir) => {
				const repoKey = "symlink";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				const target = join(agentDir, "target.json");
				await writeFile(target, "unchanged");
				await symlink(target, path);
				assert.match(blockedDiagnostic(await loadPersistedState(repoKey, 7)), /needs inspection/);
				const replacement = persistedState(repoKey, 7);
				await savePersistedState(replacement);
				assert.equal(await readFile(target, "utf8"), "unchanged");
				assert.equal((await lstat(path)).isSymbolicLink(), false);
				assert.deepEqual(await loadPersistedState(repoKey, 7), { kind: "ready", state: replacement });
			});
		});

		it("refuses to read or write through a symlinked state directory", async () => {
			await withAgentDir(async (agentDir) => {
				const dir = join(agentDir, "pr-autopilot");
				const target = join(agentDir, "real-target");
				await mkdir(target, { recursive: true });
				await symlink(target, dir, "dir");
				const repoKey = "symlinked-dir";
				assert.match(blockedDiagnostic(await loadPersistedState(repoKey, 7)), /needs inspection/);
				await savePersistedState(persistedState(repoKey, 7));
				assert.deepEqual(await readdir(target), []);
			});
		});
	});

	describe("parseTriage", () => {
		const sampleTriage = {
			checks: [
				{ key: "check-1", cls: "code", action: "Fix lint error in src/index.ts" },
				{ key: "check-2", cls: "infra", action: "External service timeout; wait and retry" },
			],
			threads: [
				{ key: "thread-1", decision: "fix", cls: "code", action: "Rename variable for clarity", reply: "Renamed." },
				{ key: "thread-2", decision: "ask", cls: "code", action: "Design rethink needed" },
			],
			conflicts: false,
			draft: false,
			summary: "Fix lint and review thread t1; report e2e infra.",
		};

		it("parses a JSON triage blob", () => {
			const result = parseTriage(JSON.stringify(sampleTriage));
			assert.equal("error" in result, false);
			if (!("error" in result)) {
				assert.equal(result.checks.length, 2);
				assert.equal(result.threads.length, 2);
				assert.equal(result.conflicts, false);
				assert.equal(result.summary, sampleTriage.summary);
				assert.equal(result.threads[0].decision, "fix");
			}
		});

		it("extracts one fenced JSON block despite a conversational prefix", () => {
			const fenced = `Here is the result:\n\`\`\`json\n${JSON.stringify(sampleTriage)}\n\`\`\`\nDone.`;
			const result = parseTriage(fenced);
			assert.equal("error" in result ? result.error : undefined, undefined);
			if (!("error" in result)) assert.equal(result.checks.length, 2);
		});

		it("returns an error for invalid JSON", () => {
			const result = parseTriage("not json at all");
			assert.ok("error" in result);
		});

		it("drops malformed and numerically unsafe triage keys", () => {
			const result = parseTriage(
				JSON.stringify({
					checks: [{ key: "check-9007199254740992", cls: "code" }],
					threads: [{ key: "thread-0", decision: "ignore" }],
				}),
			);
			if ("error" in result) throw new Error(result.error);
			assert.deepEqual(result.checks, []);
			assert.deepEqual(result.threads, []);
		});

		it("parses informational review items as ignore decisions", () => {
			const parsed = parseTriage(
				JSON.stringify({
					checks: [],
					threads: [{ key: "thread-1", decision: "ignore", action: "informational status update" }],
					conflicts: false,
					draft: false,
					summary: "No action needed.",
				}),
			);
			if ("error" in parsed) throw new Error(parsed.error);
			assert.deepEqual(parsed.threads, [
				{ key: "thread-1", decision: "ignore", action: "informational status update" },
			]);
		});
	});

	describe("applyTriageGuardrails", () => {
		it("overrides a fix decision on a security comment", () => {
			const state = buildPRState(makePr(), [makeThread("t1", "this is a security issue in auth")], [], null);
			const parsed = parseTriage(
				JSON.stringify({
					checks: [],
					threads: [{ key: "thread-1", decision: "fix", cls: "code", action: "patch it", reply: "fixed" }],
					conflicts: false,
					draft: false,
					summary: "fix",
				}),
			);
			if ("error" in parsed) throw new Error(parsed.error);
			const forced = applyTriageGuardrails(state, parsed);
			assert.equal(forced.threads[0].decision, "ask");
		});

		it("drops well-formed keys that do not identify a state record", () => {
			const state = buildPRState(makePr(), [makeThread("t1", "rename this")], [makeCheck("lint", "failure")], null);
			const parsed = parseTriage(
				JSON.stringify({
					checks: [{ key: "check-2", cls: "code", action: "invented check" }],
					threads: [{ key: "thread-2", decision: "ignore", action: "invented thread" }],
					conflicts: false,
					draft: false,
					summary: "invalid keys",
				}),
			);
			if ("error" in parsed) throw new Error(parsed.error);
			const guarded = applyTriageGuardrails(state, parsed);
			assert.deepEqual(guarded.checks, []);
			assert.deepEqual(guarded.threads, []);
		});
	});

	describe("summarizeTriage", () => {
		it("produces a one-line summary", () => {
			const result = summarizeTriage(
				JSON.stringify({
					checks: [{ key: "check-1", cls: "code", action: "fix" }],
					threads: [{ key: "thread-1", decision: "fix", cls: "code", action: "fix", reply: "ok" }],
					conflicts: false,
					draft: false,
					summary: "Fix the lint error.",
				}),
			);
			assert.match(result, /1 checks, 1 threads/);
			assert.match(result, /Fix the lint error/);
		});

		it("handles invalid JSON gracefully", () => {
			assert.equal(summarizeTriage("garbage"), "triage JSON parse failed");
		});
	});

	describe("task file builders", () => {
		const state = buildPRState(
			makePr(),
			[makeThread("1", "please rename this")],
			[
				makeCheck("lint", "success"),
				{ name: "test", status: "failure", conclusion: "failure", logExcerpt: "Error: expected 1" },
			],
			"0123456789abcdef0123456789abcdef01234567",
		);

		it("buildTriagerTask fences untrusted text and includes logs", () => {
			const task = buildTriagerTask(state, "jj");
			assert.match(task, /PR #42/);
			assert.match(task, /Base: main/);
			assert.match(task, /Failing/);
			assert.match(task, /UNTRUSTED PR DATA/);
			assert.match(task, /Error: expected 1/);
			assert.match(task, /decision/);
			assert.match(task, /"ignore" — informational/);
			assert.match(task, /VCS backend: jj/);
		});

		it("buildFixerTask includes triage and forbids workflow edits", () => {
			const fixer = buildFixerTask(
				state,
				'{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}',
				"all",
				"jj",
			);
			assert.match(fixer, /PR #42/);
			assert.match(fixer, /Fix Phase/);
			assert.match(fixer, /VERIFY_FAIL/);
			assert.match(fixer, /UNTRUSTED PR DATA/);
			assert.match(fixer, /VCS backend: jj/);
			assert.doesNotMatch(fixer, /Head ref:/);
		});

		it("fixer task for threads mode says threads only", () => {
			const fixer = buildFixerTask(
				state,
				'{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}',
				"threads",
				"git",
			);
			assert.match(fixer, /review threads marked fix only/);
		});

		it("fixer task for ci mode says CI only", () => {
			const fixer = buildFixerTask(
				state,
				'{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}',
				"ci",
				"git",
			);
			assert.match(fixer, /code CI failures only/);
		});
	});
});
