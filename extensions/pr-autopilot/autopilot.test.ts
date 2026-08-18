import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import { JjBackend } from "../shared/vcs/jj-backend.ts";
import {
	applyForceAsk,
	classifyBlockers,
	doCommitAndPush,
	fetchPRState,
	loadPersistedState,
	parseTriage,
	persistPath,
	prepareMutationCheckout,
	runCleanup,
	savePersistedState,
	summarizeTriage,
} from "./autopilot-operations.ts";
import { DEFAULT_TINY_MODELS } from "./config.ts";
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
import type { CheckRun, ExecFn, ReviewThread } from "./types.ts";

const changeTemplate = 'change_id ++ "\\n"';

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

function makeThread(id: string, body = "Looks good to me"): ReviewThread {
	return { id, commenter: "reviewer", body, path: "src/index.ts", line: 10, source: "review-thread", replyToId: 1 };
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
	});

	describe("mutation checkout boundary", () => {
		it("rejects a checkout on a different branch", async () => {
			const exec: ExecFn = async (command, args) => {
				if (command === "git" && args[0] === "branch") return { code: 0, stdout: "kstack/other\n", stderr: "" };
				if (command === "git" && args[0] === "rev-parse")
					return { code: 0, stdout: `${makePr().headSha}\n`, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
			const state = buildPRState(makePr(), [], [], null);
			const result = await prepareMutationCheckout(new GitBackend(exec), "/repo", state);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /current workstream is/);
		});

		it("accepts a clean jj head checkpoint with the PR bookmark at @", async () => {
			const pr = makePr();
			const exec: ExecFn = async (command, args) => {
				assert.equal(command, "jj");
				if (args.includes("bookmark") && args.includes("list")) {
					return { code: 0, stdout: `${pr.headRefName}\n`, stderr: "" };
				}
				if (args.includes('if(empty, "true", "false")')) {
					return { code: 0, stdout: "true", stderr: "" };
				}
				if (args.includes("log")) return { code: 0, stdout: `${pr.headSha}\n`, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
			const result = await prepareMutationCheckout(new JjBackend(exec), "/repo", buildPRState(pr, [], [], null));
			assert.deepEqual(result, {
				ok: true,
				snapshot: { ref: pr.headRefName, token: `${pr.headRefName}@${pr.headSha}/parents:${pr.headSha}` },
			});
		});

		it("rejects an advanced remote jj head without creating a merge", async () => {
			const pr = makePr();
			const advanced = "8".repeat(40);
			const calls: string[] = [];
			const exec: ExecFn = async (_command, args) => {
				calls.push(args.join(" "));
				if (args.includes("bookmark") && args.includes("list")) {
					return { code: 0, stdout: `${pr.headRefName}\n`, stderr: "" };
				}
				if (args.includes('if(empty, "true", "false")')) {
					return { code: 0, stdout: "true", stderr: "" };
				}
				if (args.includes(`${pr.headRefName}@origin`)) {
					return { code: 0, stdout: `${advanced}\n`, stderr: "" };
				}
				if (args.includes("log")) return { code: 0, stdout: `${pr.headSha}\n`, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
			const result = await prepareMutationCheckout(new JjBackend(exec), "/repo", buildPRState(pr, [], [], null));
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, new RegExp(advanced));
			assert.equal(
				calls.some((call) => call.includes(" new ")),
				false,
			);
		});

		it("rejects a jj PR head without an empty automation checkpoint", async () => {
			const pr = makePr();
			const exec: ExecFn = async (_command, args) => {
				if (args.includes("bookmark") && args.includes("list")) {
					return { code: 0, stdout: `${pr.headRefName}\n`, stderr: "" };
				}
				if (args.includes('if(empty, "true", "false")')) {
					return { code: 0, stdout: "false", stderr: "" };
				}
				if (args.includes("--summary")) return { code: 0, stdout: "M src/index.ts\n", stderr: "" };
				if (args.includes("log")) return { code: 0, stdout: `${pr.headSha}\n`, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
			const result = await prepareMutationCheckout(new JjBackend(exec), "/repo", buildPRState(pr, [], [], null));
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /must be clean/);
		});

		it("rejects a dirty selected checkout before running a fixer", async () => {
			const pr = makePr();
			const exec: ExecFn = async (_command, args) => {
				if (args[0] === "branch") return { code: 0, stdout: `${pr.headRefName}\n`, stderr: "" };
				if (args[0] === "rev-parse") return { code: 0, stdout: `${pr.headSha}\n`, stderr: "" };
				if (args[0] === "status") return { code: 0, stdout: " M user-work.ts\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
			const result = await prepareMutationCheckout(new GitBackend(exec), "/repo", buildPRState(pr, [], [], null));
			assert.deepEqual(result, {
				ok: false,
				error: "The Git checkout must be clean before pr-autopilot can mutate it.",
			});
		});
	});

	describe("jj fixer publication", () => {
		it("accepts jj snapshot SHA changes, commits the path diff, and pushes an empty checkpoint", async () => {
			const expectedChangeId = "stable-change-id";
			const edited = "2".repeat(40);
			const checkpoint = "3".repeat(40);
			let committed = false;
			const calls: string[] = [];
			const exec: ExecFn = async (_command, args) => {
				calls.push(args.join(" "));
				if (args.includes("bookmark") && args.includes("list")) {
					return { code: 0, stdout: "feature\n", stderr: "" };
				}
				if (args.includes("--name-only")) return { code: 0, stdout: "src/fix.ts\n", stderr: "" };
				if (args.includes("commit")) {
					committed = true;
					return { code: 0, stdout: "", stderr: "" };
				}
				if (args.includes('if(empty, "true", "false")')) {
					return { code: 0, stdout: "true", stderr: "" };
				}
				if (args.includes(changeTemplate)) {
					return { code: 0, stdout: `${expectedChangeId}\n`, stderr: "" };
				}
				if (args.includes("log")) {
					return { code: 0, stdout: `${committed ? checkpoint : edited}\n`, stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			};
			const result = await doCommitAndPush(
				new JjBackend(exec),
				"/repo",
				{ ref: "feature", token: `feature@${expectedChangeId}/parents:${edited}` },
				42,
				"VERIFY_OK",
			);
			assert.deepEqual(result, { kind: "pushed", headSha: checkpoint });
			assert.ok(calls.some((call) => call.includes('commit cwd:"src/fix.ts" -m Autopilot PR #42')));
			assert.ok(calls.includes("--no-pager bookmark set feature -r @"));
			assert.ok(calls.includes("--no-pager git push --remote origin --bookmark feature"));
		});

		it("rejects a fixer that replaces the native jj change identity", async () => {
			const exec: ExecFn = async (_command, args) => {
				if (args.includes("bookmark") && args.includes("list")) {
					return { code: 0, stdout: "feature\n", stderr: "" };
				}
				if (args.includes("--name-only")) return { code: 0, stdout: "src/fix.ts\n", stderr: "" };
				if (args.includes(changeTemplate)) return { code: 0, stdout: "stable-change-id\n", stderr: "" };
				if (args.includes("log")) return { code: 0, stdout: `${"9".repeat(40)}\n`, stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
			const result = await doCommitAndPush(
				new JjBackend(exec),
				"/repo",
				{ ref: "feature", token: `feature@stable-change-id/parents:${"1".repeat(40)}` },
				42,
				"VERIFY_OK",
			);
			assert.equal(result.kind, "failed");
			if (result.kind === "failed") assert.match(result.error, /identity/);
		});
	});

	describe("forbidden path restoration", () => {
		const sha = makePr().headSha;
		const identity = { ref: "kstack/fix-thing", token: `kstack/fix-thing@${sha}` };

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

		function identityResponses(overrides: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
			return {
				"branch --show-current": { stdout: "kstack/fix-thing\n" },
				"rev-parse HEAD": { stdout: `${sha}\n` },
				"status --porcelain=v1 -z --untracked-files=all": { stdout: "?? .env.local\0" },
				...overrides,
			};
		}

		it("restores a forbidden path and does not commit or push", async () => {
			const { exec, calls } = gitResponses(
				identityResponses({
					"restore --staged --worktree -- .env.local": {},
				}),
			);
			const result = await doCommitAndPush(new GitBackend(exec), "/repo", identity, 42, "VERIFY_OK");
			assert.deepEqual(result, {
				kind: "failed",
				error: "Fixer touched forbidden paths: .env.local. Those changes were restored.",
			});
			assert.ok(calls.includes("restore --staged --worktree -- .env.local"));
			assert.equal(
				calls.some((call) => call.startsWith("add ") || call.startsWith("commit ") || call.startsWith("push ")),
				false,
			);
		});

		it("includes the restoration error and does not commit or push", async () => {
			const { exec, calls } = gitResponses(
				identityResponses({
					"restore --staged --worktree -- .env.local": { code: 1, stderr: "restore denied\n" },
					"clean -f -- .env.local": { code: 1, stderr: "clean denied\n" },
				}),
			);
			const result = await doCommitAndPush(new GitBackend(exec), "/repo", identity, 42, "VERIFY_OK");
			assert.equal(result.kind, "failed");
			if (result.kind === "failed") {
				assert.match(result.error, /Fixer touched forbidden paths: \.env\.local/);
				assert.match(result.error, /Automatic restoration failed: \.env\.local: restore denied/);
			}
			assert.equal(
				calls.some((call) => call.startsWith("add ") || call.startsWith("commit ") || call.startsWith("push ")),
				false,
			);
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

	describe("required GitHub state", () => {
		it("does not turn failed auxiliary fetches into empty successful state", async () => {
			const pr = makePr();
			const exec: ExecFn = async (command, args) => {
				if (command === "gh" && args[0] === "pr" && args[1] === "view") {
					return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "network unavailable" };
			};
			const result = await fetchPRState(exec, "/repo", 42, null, { concurrency: 1, handledThreadIds: [] });
			assert.equal(typeof result, "string");
			assert.match(String(result), /Could not fetch/);
		});
	});

	describe("pickModel", () => {
		it("picks one model from the pool using the injected random source", () => {
			const models = DEFAULT_TINY_MODELS;
			assert.equal(pickModel(models, () => 0).label, "luna");
			assert.equal(pickModel(models, () => 0.32).label, "luna");
			assert.equal(pickModel(models, () => 1 / 3).label, "gemini");
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

		it("uses distinct paths for the same PR in different repositories", () => {
			assert.notEqual(persistPath("repo-a", 5), persistPath("repo-b", 5));
		});

		it("round-trips handled thread ids with its repository key", async () => {
			await withAgentDir(async () => {
				const repoKey = `test-${process.pid}-${Date.now()}`;
				await savePersistedState({
					repoKey,
					prNumber: 5,
					headSha: "abc",
					handledThreadIds: ["thread-1"],
					repliedThreadIds: [],
					flakeRetried: [],
				});
				const loaded = await loadPersistedState(repoKey, 5);
				assert.deepEqual(loaded.handledThreadIds, ["thread-1"]);
				assert.equal(loaded.repoKey, repoKey);
			});
		});

		it("refuses to read persisted state through a symlink", async () => {
			await withAgentDir(async (agentDir) => {
				const repoKey = "symlink-read";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				const target = join(agentDir, "target.json");
				await writeFile(
					target,
					JSON.stringify({
						repoKey,
						prNumber: 7,
						headSha: "hijacked",
						handledThreadIds: ["evil"],
						repliedThreadIds: [],
						flakeRetried: [],
					}),
				);
				await symlink(target, path);
				const loaded = await loadPersistedState(repoKey, 7);
				assert.equal(loaded.repoKey, repoKey);
				assert.deepEqual(loaded.handledThreadIds, []);
			});
		});

		it("refuses to write persisted state through a symlink", async () => {
			await withAgentDir(async (agentDir) => {
				const repoKey = "symlink-write";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				const target = join(agentDir, "target.json");
				await writeFile(target, "unchanged");
				await symlink(target, path);
				await savePersistedState({
					repoKey,
					prNumber: 7,
					headSha: "new",
					handledThreadIds: ["t"],
					repliedThreadIds: [],
					flakeRetried: [],
				});
				assert.equal(await readFile(target, "utf8"), "unchanged");
			});
		});

		it("refuses to read or write through a symlinked state directory", async () => {
			await withAgentDir(async (agentDir) => {
				const dir = join(agentDir, "pr-autopilot");
				const target = join(agentDir, "real-target");
				await mkdir(target, { recursive: true });
				await symlink(target, dir, "dir");
				const repoKey = "symlinked-dir";
				const loaded = await loadPersistedState(repoKey, 7);
				assert.deepEqual(loaded.handledThreadIds, []);
				await savePersistedState({
					repoKey,
					prNumber: 7,
					headSha: "new",
					handledThreadIds: ["t"],
					repliedThreadIds: [],
					flakeRetried: [],
				});
				assert.deepEqual(await readdir(target), []);
			});
		});

		it("returns empty state for malformed JSON", async () => {
			await withAgentDir(async () => {
				const repoKey = "malformed";
				const path = persistPath(repoKey, 7);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, "not json");
				const loaded = await loadPersistedState(repoKey, 7);
				assert.deepEqual(loaded.handledThreadIds, []);
				assert.equal(loaded.repoKey, repoKey);
			});
		});
	});

	describe("parseTriage and classifyBlockers", () => {
		const sampleTriage = {
			checks: [
				{ name: "lint", cls: "code", action: "Fix lint error in src/index.ts" },
				{ name: "e2e", cls: "infra", action: "External service timeout; wait and retry" },
			],
			threads: [
				{ id: "t1", decision: "fix", cls: "code", action: "Rename variable for clarity", reply: "Renamed." },
				{ id: "t2", decision: "ask", cls: "code", action: "Design rethink needed" },
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

		it("classifies blockers: infra CI and ask threads", () => {
			const parsed = parseTriage(JSON.stringify(sampleTriage));
			if ("error" in parsed) throw new Error(parsed.error);
			const classification = classifyBlockers(parsed);
			assert.equal(classification.hasUnfixableCI, true);
			assert.equal(classification.hasAskThreads, true);
		});

		it("classifies no ask threads when all are fix", () => {
			const parsed = parseTriage(
				JSON.stringify({
					...sampleTriage,
					threads: [{ id: "t1", decision: "fix", cls: "code", action: "Fix", reply: "done" }],
				}),
			);
			if ("error" in parsed) throw new Error(parsed.error);
			assert.equal(classifyBlockers(parsed).hasAskThreads, false);
			assert.equal(classifyBlockers(parsed).hasUnfixableCI, true);
		});
	});

	describe("applyForceAsk", () => {
		it("overrides a fix decision on a security comment", () => {
			const state = buildPRState(makePr(), [makeThread("t1", "this is a security issue in auth")], [], null);
			const parsed = parseTriage(
				JSON.stringify({
					checks: [],
					threads: [{ id: "t1", decision: "fix", cls: "code", action: "patch it", reply: "fixed" }],
					conflicts: false,
					draft: false,
					summary: "fix",
				}),
			);
			if ("error" in parsed) throw new Error(parsed.error);
			const forced = applyForceAsk(state, parsed);
			assert.equal(forced.threads[0].decision, "ask");
		});
	});

	describe("summarizeTriage", () => {
		it("produces a one-line summary", () => {
			const result = summarizeTriage(
				JSON.stringify({
					checks: [{ name: "lint", cls: "code", action: "fix" }],
					threads: [{ id: "t1", decision: "fix", cls: "code", action: "fix", reply: "ok" }],
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
			assert.match(fixer, /Head ref: kstack\/fix-thing/);
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
