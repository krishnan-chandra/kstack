import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildReviewInstructions,
	capReviewDiff,
	combineAdversaryResults,
	summarizeFindings,
} from "./adversary-review.ts";
import type { AgentRunResult } from "./types.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const advisors = [
	{ label: "adversary-1", model: "openai/astra:medium" },
	{ label: "adversary-2", model: "openai/terra:medium" },
];

function completed(output: string, model = "openai/astra:medium"): AgentRunResult {
	return { status: "completed", role: "adversary", model, output, usage };
}

const approve = "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n";
const revise = "Verdict: revise\n\n## Blocking\n- [B-1] Off-by-one.\n\n## Suggestions\n- [S-1] Rename it.\n";

describe("combineAdversaryResults", () => {
	it("approves only when every adversary approves", () => {
		const outcome = combineAdversaryResults(advisors, [completed(approve), completed(approve)]);
		assert.equal(outcome.approved, true);
		assert.equal(outcome.failures.length, 0);
		assert.match(outcome.verdict, /Decision: approve/);
		assert.match(outcome.verdict, /## adversary-1 — openai\/astra:medium/);
		assert.match(outcome.verdict, /## adversary-2 — openai\/terra:medium/);
		assert.deepEqual(outcome.openFindings, []);
	});

	it("keeps the round unapproved and labels open findings by adversary", () => {
		const outcome = combineAdversaryResults(advisors, [
			completed(revise),
			completed("Verdict: approve\n\n## Blocking\n- [B-7] Leaked handle.\n\n## Suggestions\nNone.\n"),
		]);
		assert.equal(outcome.approved, false);
		assert.match(outcome.verdict, /Decision: revise/);
		assert.deepEqual(
			outcome.openFindings.map((finding) => finding.id),
			["adversary-1/B-1", "adversary-2/B-7"],
		);
	});

	it("treats a failed or unparseable adversary as not approving", () => {
		const failed: AgentRunResult = { status: "failed", role: "adversary", model: "x", error: "timed out" };
		const outcome = combineAdversaryResults(advisors, [completed(approve), failed]);
		assert.equal(outcome.approved, false);
		assert.equal(outcome.failures.length, 1);
		assert.match(outcome.failures[0] ?? "", /adversary-2.*timed out/);
		assert.match(outcome.verdict, /## Adversary failures/);

		const malformed = combineAdversaryResults(advisors, [completed(approve), completed("no verdict here")]);
		assert.equal(malformed.approved, false);
		assert.match(malformed.failures[0] ?? "", /adversary-2/);
	});

	it("rejects a missing result instead of silently ignoring it", () => {
		const outcome = combineAdversaryResults(advisors, [completed(approve)]);
		assert.equal(outcome.approved, false);
		assert.match(outcome.failures[0] ?? "", /adversary-2.*no result/);
	});

	it("refuses to approve when a completed adversary reports a cleanup failure", () => {
		const outcome = combineAdversaryResults(advisors, [
			{ ...completed(approve), cleanupError: "EPERM" },
			completed(approve),
		]);
		assert.equal(outcome.approved, false);
		assert.match(outcome.failures[0] ?? "", /adversary-1.*cleanup failed: EPERM/);
	});
});

describe("capReviewDiff", () => {
	it("passes small diffs through unchanged", () => {
		assert.deepEqual(capReviewDiff("short", 16), { text: "short", truncated: false });
	});

	it("truncates on a UTF-8 boundary", () => {
		const capped = capReviewDiff("é".repeat(20), 10);
		assert.equal(capped.truncated, true);
		assert.ok(Buffer.byteLength(capped.text, "utf8") <= 10);
		assert.equal(capped.text.endsWith("é"), true);
	});
});

describe("buildReviewInstructions", () => {
	it("names every file the adversary must read", () => {
		const instructions = buildReviewInstructions({
			taskFile: "/run/task.md",
			planFile: "/run/approved-plan.md",
			ledgerFile: "/run/execution-ledger.md",
			diffFile: "/run/change.diff",
		});
		assert.match(instructions, /\/run\/task\.md/);
		assert.match(instructions, /\/run\/approved-plan\.md/);
		assert.match(instructions, /\/run\/execution-ledger\.md/);
		assert.match(instructions, /\/run\/change\.diff/);
		assert.match(instructions, /untrusted data/);
	});
});

describe("summarizeFindings", () => {
	it("lists findings and counts the remainder", () => {
		const findings = Array.from({ length: 8 }, (_value, index) => ({ id: `B-${index}`, text: `finding ${index}` }));
		const summary = summarizeFindings(findings, 3);
		assert.match(summary, /\[B-0\] finding 0/);
		assert.match(summary, /…and 5 more\./);
	});
});
