import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyForceAsk,
	classifyBlockers,
	fetchPRState,
	loadPersistedState,
	parseTriage,
	persistPath,
	prepareMutationCheckout,
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
			const result = await prepareMutationCheckout(exec, "/repo", state);
			assert.equal(result.ok, false);
			if (!result.ok) assert.match(result.error, /different|checkout is on/);
		});

		it("rejects a dirty selected checkout before running a fixer", async () => {
			const pr = makePr();
			const exec: ExecFn = async (_command, args) => {
				if (args[0] === "branch") return { code: 0, stdout: `${pr.headRefName}\n`, stderr: "" };
				if (args[0] === "rev-parse") return { code: 0, stdout: `${pr.headSha}\n`, stderr: "" };
				if (args[0] === "status") return { code: 0, stdout: " M user-work.ts\n", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			};
			const result = await prepareMutationCheckout(exec, "/repo", buildPRState(pr, [], [], null));
			assert.deepEqual(result, {
				ok: false,
				error: "The PR worktree must be clean before pr-autopilot can mutate it.",
			});
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
		it("round-robins across tiny models", () => {
			const models = DEFAULT_TINY_MODELS;
			assert.equal(pickModel(models, 0).label, "luna");
			assert.equal(pickModel(models, 1).label, "gemini");
			assert.equal(pickModel(models, 2).label, "deepseek");
			assert.equal(pickModel(models, 3).label, "luna");
		});
	});

	describe("persisted state", () => {
		it("uses distinct paths for the same PR in different repositories", () => {
			assert.notEqual(persistPath("repo-a", 5), persistPath("repo-b", 5));
		});

		it("round-trips handled thread ids with its repository key", async () => {
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
			const task = buildTriagerTask(state);
			assert.match(task, /PR #42/);
			assert.match(task, /Base: main/);
			assert.match(task, /Failing/);
			assert.match(task, /UNTRUSTED PR DATA/);
			assert.match(task, /Error: expected 1/);
			assert.match(task, /decision/);
		});

		it("buildFixerTask includes triage and forbids workflow edits", () => {
			const fixer = buildFixerTask(
				state,
				'{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}',
				"all",
			);
			assert.match(fixer, /PR #42/);
			assert.match(fixer, /Fix Phase/);
			assert.match(fixer, /VERIFY_FAIL/);
			assert.match(fixer, /UNTRUSTED PR DATA/);
		});

		it("fixer task for threads mode says threads only", () => {
			const fixer = buildFixerTask(
				state,
				'{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}',
				"threads",
			);
			assert.match(fixer, /review threads marked fix only/);
		});

		it("fixer task for ci mode says CI only", () => {
			const fixer = buildFixerTask(
				state,
				'{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}',
				"ci",
			);
			assert.match(fixer, /code CI failures only/);
		});
	});
});
