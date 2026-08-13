import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildPRState,
	buildTriagerTask,
	buildFixerTask,
	classifyBlockers,
	describeBlockers,
	isMergeReady,
	pickModel,
	parseTriage,
	summarizeTriage,
} from "./babysit.ts";
import { DEFAULT_TINY_MODELS } from "./config.ts";
import type { CheckRun, GHPrJson, ReviewThread } from "./types.ts";

function makePr(overrides: Partial<GHPrJson> = {}): GHPrJson {
	return {
		number: 42,
		title: "Fix the thing",
		state: "open",
		isDraft: false,
		mergeable: "true",
		headRefName: "kstack/fix-thing",
		baseRefName: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		commits: [{ oid: "0123456789abcdef0123456789abcdef01234567" }],
		...overrides,
	};
}

function makeCheck(name: string, conclusion: CheckRun["conclusion"], status: CheckRun["status"] = "completed"): CheckRun {
	return { name, conclusion, status };
}

function makeThread(id: string, status: ReviewThread["status"] = "COMMENTED"): ReviewThread {
	return { id, commenter: "reviewer", body: "Looks good to me", status, path: "src/index.ts", line: 10 };
}

describe("pr-babysit state machine", () => {
	describe("buildPRState", () => {
		it("maps GitHub JSON to PRState", () => {
			const state = buildPRState(makePr(), [makeThread("1")], [makeCheck("lint", "success")], null);
			assert.equal(state.number, 42);
			assert.equal(state.headSha, "0123456789abcdef0123456789abcdef01234567");
			assert.equal(state.baseRef, "main");
			assert.equal(state.headRef, "kstack/fix-thing");
			assert.equal(state.mergeable, "mergeable");
			assert.equal(state.hasUnresolvedThreads, true);
		});

		it("translates mergeable=false to conflicting", () => {
			const state = buildPRState(makePr({ mergeable: "false" }), [], [], null);
			assert.equal(state.mergeable, "conflicting");
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

	describe("isMergeReady", () => {
		it("returns true when green, no threads, mergeable, not draft", () => {
			const state = buildPRState(
				makePr({ isDraft: false, mergeable: "true" }),
				[],
				[makeCheck("lint", "success"), makeCheck("test", "skipped")],
				null,
			);
			assert.equal(isMergeReady(state), true);
		});

		it("returns false when draft", () => {
			const state = buildPRState(makePr({ isDraft: true, mergeable: "true" }), [], [makeCheck("lint", "success")], null);
			assert.equal(isMergeReady(state), false);
		});

		it("returns false when there are unresolved threads", () => {
			const state = buildPRState(makePr({ mergeable: "true" }), [makeThread("1", "COMMENTED")], [makeCheck("lint", "success")], null);
			assert.equal(isMergeReady(state), false);
		});

		it("returns false when checks are failing", () => {
			const state = buildPRState(makePr({ mergeable: "true" }), [], [makeCheck("lint", "failure")], null);
			assert.equal(isMergeReady(state), false);
		});

		it("returns false when conflicts", () => {
			const state = buildPRState(makePr({ mergeable: "false" }), [], [makeCheck("lint", "success")], null);
			assert.equal(isMergeReady(state), false);
		});
	});

	describe("describeBlockers", () => {
		it("lists all blockers", () => {
			const state = buildPRState(
				makePr({ isDraft: true, mergeable: "false" }),
				[makeThread("1", "COMMENTED")],
				[makeCheck("lint", "failure")],
				null,
			);
			const desc = describeBlockers(state);
			assert.match(desc, /draft/);
			assert.match(desc, /conflicts/);
			assert.match(desc, /unresolved threads/);
			assert.match(desc, /failing check/);
		});

		it("returns clean when nothing blocks", () => {
			const state = buildPRState(makePr({ mergeable: "true" }), [], [], null);
			assert.equal(describeBlockers(state), "unknown blocker");
		});
	});

	describe("pickModel", () => {
		it("round-robins across tiny models", () => {
			const models = DEFAULT_TINY_MODELS;
			assert.equal(pickModel(models, "triager", 0).label, "luna");
			assert.equal(pickModel(models, "triager", 1).label, "gemini");
			assert.equal(pickModel(models, "triager", 2).label, "deepseek");
			assert.equal(pickModel(models, "triager", 3).label, "luna");
		});
	});

	describe("parseTriage and classifyBlockers", () => {
		const sampleTriage = {
			checks: [
				{ name: "lint", cls: "code", action: "Fix lint error in src/index.ts" },
				{ name: "e2e", cls: "infra", action: "External service timeout; wait and retry" },
			],
			threads: [
				{ id: "t1", cls: "code", action: "Rename variable for clarity", fixable: true },
				{ id: "t2", cls: "code", action: "Design rethink needed", fixable: false },
			],
			conflicts: false,
			draft: false,
			summary: "Fix lint and review thread t1; report e2e infra.",
		};

		it("parses a JSON triage blob", () => {
			const result = parseTriage(JSON.stringify(sampleTriage));
			assert.equal(result.error, undefined);
			if (!("error" in result)) {
				assert.equal(result.checks.length, 2);
				assert.equal(result.threads.length, 2);
				assert.equal(result.conflicts, false);
				assert.equal(result.summary, sampleTriage.summary);
			}
		});

		it("strips markdown fences before parsing", () => {
			const fenced = "```json\n" + JSON.stringify(sampleTriage) + "\n```";
			const result = parseTriage(fenced);
			assert.equal("error" in result ? result.error : undefined, undefined);
			if (!("error" in result)) assert.equal(result.checks.length, 2);
		});

		it("returns an error for invalid JSON", () => {
			const result = parseTriage("not json at all");
			assert.ok("error" in result);
		});

		it("classifies blockers: infra CI and non-fixable threads", () => {
			const classification = classifyBlockers(JSON.stringify(sampleTriage));
			if ("error" in classification) throw new Error(classification.error);
			assert.equal(classification.hasUnfixableCI, true); // "infra" check
			assert.equal(classification.hasUnfixableThreads, true); // t2 not fixable
		});

		it("classifies no blockers when all fixable", () => {
			const allFixable = { ...sampleTriage, threads: [{ id: "t1", cls: "code", action: "Fix", fixable: true }] };
			const classification = classifyBlockers(JSON.stringify(allFixable));
			if ("error" in classification) throw new Error(classification.error);
			assert.equal(classification.hasUnfixableCI, true); // e2e is still infra
			assert.equal(classification.hasUnfixableThreads, false);
		});
	});

	describe("summarizeTriage", () => {
		it("produces a one-line summary", () => {
			const result = summarizeTriage(JSON.stringify({
				checks: [{ name: "lint", cls: "code", action: "fix" }],
				threads: [{ id: "t1", cls: "code", action: "fix", fixable: true }],
				conflicts: false,
				draft: false,
				summary: "Fix the lint error.",
			}));
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
			[makeThread("1"), makeThread("2", "RESOLVED")],
			[makeCheck("lint", "success"), makeCheck("test", "failure")],
			"0123456789abcdef0123456789abcdef01234567",
		);

		it("buildTriagerTask includes PR metadata and checks", () => {
			const task = buildTriagerTask(state);
			assert.match(task, /PR #42/);
			assert.match(task, /Base: main/);
			assert.match(task, /Failing/);
			assert.match(task, /1 open/);
		});

		it("buildFixerTask includes triage and PR state snapshot", () => {
			const fixer = buildFixerTask(state, '{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}', "all");
			assert.match(fixer, /PR #42/);
			assert.match(fixer, /Fix Phase/);
			assert.match(fixer, /Triage from the tiny-model classifier/);
		});

		it("fixer task for threads mode says threads only", () => {
			const fixer = buildFixerTask(state, '{"checks":[],"threads":[],"conflicts":false,"draft":false,"summary":""}', "threads");
			assert.match(fixer, /review threads only/);
		});
	});
});
