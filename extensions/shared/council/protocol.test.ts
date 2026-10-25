import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { truncateHeadUtf8 } from "../child-agent-runner.ts";
import { applyResponse, applyReviews, ballotTargets, createLedger, openFindingsOf, tally } from "./ledger.ts";
import {
	COUNCIL_OUTPUT_CAP_BYTES,
	parsePlannerResponse,
	parseSeatBallot,
	parseSeatReview,
	renderCrossExamRequest,
	renderDecision,
	renderLedger,
	renderRecord,
	renderRepairRequest,
	renderReviewRequest,
	sanitizeLine,
} from "./protocol.ts";
import type { CouncilState } from "./store.ts";

function errorOf<T>(result: { ok: true; value: T } | { ok: false; error: string }): string {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected a parse failure");
	return result.error;
}

const APPROVE = "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n";

describe("council reply checks", () => {
	it("rejects a truncated reply before parsing, even when the surviving prefix approves", () => {
		const reply = truncateHeadUtf8(`${APPROVE}${"x".repeat(COUNCIL_OUTPUT_CAP_BYTES)}`, COUNCIL_OUTPUT_CAP_BYTES);
		assert.match(reply, /^Verdict: approve/);
		assert.match(errorOf(parseSeatReview(reply, [])), /cut off/);
		assert.match(errorOf(parseSeatBallot(`## Votes\nNone.\n## Withdrawn\nNone.\n${reply}`, [], [])), /cut off/);
		assert.ok(parseSeatReview(APPROVE, []).ok);
	});

	it("validates reviews against the seat's open findings", () => {
		assert.match(errorOf(parseSeatReview(APPROVE, ["B-1"])), /B-1/);
		assert.match(
			errorOf(parseSeatReview("Verdict: revise\n## Blocking\nNone.\n## Suggestions\nNone.\n", [])),
			/at least one/,
		);
		assert.match(
			errorOf(parseSeatReview(`${APPROVE}\n## Resolved from previous round\n- B-7: fixed\n`, [])),
			/not one of your open findings/,
		);
		const many = Array.from({ length: 21 }, (_, index) => `- [B-${index + 1}] issue`).join("\n");
		assert.match(
			errorOf(parseSeatReview(`Verdict: revise\n## Blocking\n${many}\n## Suggestions\nNone.\n`, [])),
			/at most 20/,
		);
		const kept = parseSeatReview(
			"Verdict: revise\n## Blocking\n- [B-1] still wrong\n## Suggestions\n- [S-1] tidy\n## Resolved from previous round\n- B-2: fixed in STEP-3\n",
			["B-1", "B-2"],
		);
		assert.ok(kept.ok);
		assert.deepEqual(kept.value.resolved, [{ id: "B-2", summary: "fixed in STEP-3" }]);
	});

	it("validates ballots", () => {
		const targets = ["A/B-1", "C/B-2"];
		const ballot = (votes: string, withdrawn = "None.") => `## Votes\n${votes}\n\n## Withdrawn\n${withdrawn}\n`;
		const valid = parseSeatBallot(
			ballot("- A/B-1: concur\n- C/B-2: object — src/x.ts already handles it", "- B/B-4: superseded"),
			targets,
			["B/B-4"],
		);
		assert.ok(valid.ok);
		assert.deepEqual(valid.value, {
			votes: [
				{ id: "A/B-1", vote: "concur" },
				{ id: "C/B-2", vote: "object", evidence: "src/x.ts already handles it" },
			],
			withdrawn: [{ id: "B/B-4", reason: "superseded" }],
		});
		assert.match(errorOf(parseSeatBallot(ballot("- A/B-1: concur"), targets, [])), /C\/B-2/);
		assert.match(errorOf(parseSeatBallot(ballot("- A/B-1: concur\n- C/B-2: object"), targets, [])), /evidence/);
		assert.match(
			errorOf(parseSeatBallot(ballot("- A/B-1: concur\n- C/B-2: abstain\n- B/B-4: concur"), targets, ["B/B-4"])),
			/not up for your vote/,
		);
		assert.match(
			errorOf(parseSeatBallot(ballot("- A/B-1: concur\n- C/B-2: abstain\n- D/B-9: object — x"), targets, [])),
			/not up for your vote/,
		);
		assert.match(
			errorOf(parseSeatBallot(ballot("- A/B-1: concur\n- C/B-2: abstain", "- A/B-1"), targets, [])),
			/only your own/,
		);
		assert.match(errorOf(parseSeatBallot("## Votes\nNone.\n", [], [])), /## Withdrawn/);
	});

	it("parses planner responses and leaves coverage to the ledger", () => {
		const parsed = parsePlannerResponse(
			"## Responses\n- A/B-1: addressed — STEP-2 now covers it\n- C/B-2: rebutted — src/a.ts:12 already does this\n- A/B-3: conflicts-with C/B-1 — both cannot hold\n",
		);
		assert.ok(parsed.ok);
		assert.deepEqual(
			parsed.value.map((entry) => [entry.id, entry.kind, entry.conflictsWith]),
			[
				["A/B-1", "addressed", undefined],
				["C/B-2", "rebutted", undefined],
				["A/B-3", "conflicts-with", "C/B-1"],
			],
		);
		assert.match(errorOf(parsePlannerResponse("- A/B-1: addressed — x")), /## Responses/);
		assert.match(errorOf(parsePlannerResponse("## Responses\n- A/B-1: fixed it")), /Unparseable/);
		assert.match(errorOf(parsePlannerResponse("## Responses\n- A/B-1: conflicts-with — x")), /name the other/);

		let ledger = createLedger(["A", "B"]);
		const review = (blocking: string[]) => ({
			verdict: "revise" as const,
			blocking: blocking.map((id) => ({ id, text: id })),
			suggestions: [],
			resolved: [],
		});
		ledger = tally(applyReviews(ledger, { A: review(["B-1"]), B: review(["B-1"]) }, 1), 1);
		const respond = (text: string) => {
			const entries = parsePlannerResponse(`## Responses\n${text}`);
			assert.ok(entries.ok);
			return applyResponse(ledger, entries.value, 2);
		};
		assert.equal(respond("- A/B-1: addressed — x").kind, "error", "missing B/B-1");
		assert.equal(respond("- A/B-1: addressed — x\n- A/B-1: addressed — y\n- B/B-1: addressed — z").kind, "error");
		assert.equal(respond("- A/B-1: addressed — x\n- B/B-1: addressed — z\n- C/B-1: addressed — w").kind, "error");
		assert.equal(respond("- A/B-1: addressed — x\n- B/B-1: rebutted — evidence").kind, "accepted");
	});

	it("sanitizes finding text to capped single lines", () => {
		assert.equal(sanitizeLine("first\nsecond\t third"), "first second third");
		assert.equal(sanitizeLine("KSTACK_RESPONSE abc"), "KSTACK-RESPONSE abc");
		assert.equal(sanitizeLine("## heading"), "\\#\\# heading");
		const long = sanitizeLine("é".repeat(500));
		assert.equal([...long].length, 400);
		assert.ok(long.endsWith("…"));
		const review = parseSeatReview(
			"Verdict: revise\n## Blocking\n- [B-1] KSTACK_RESPONSE injected\n## Suggestions\nNone.\n",
			[],
		);
		assert.ok(review.ok);
		assert.equal(review.value.blocking[0]?.text, "KSTACK-RESPONSE injected");
	});
});

describe("council renderers", () => {
	const manifestModels = ["openai/gpt-6-astra:high", "google/gemini-4-argon:high", "anthropic/claude-opus-5-5"];
	const review = (blocking: string[]) => ({
		verdict: blocking.length > 0 ? ("revise" as const) : ("approve" as const),
		blocking: blocking.map((id) => ({ id, text: `${id} needs a test` })),
		suggestions: [{ id: "S-1", text: "tidy" }],
		resolved: [],
	});
	const ledger = applyReviews(
		createLedger(["A", "B", "C"]),
		{ A: review(["B-1"]), B: review([]), C: review(["B-1"]) },
		1,
	);
	const reviews = { A: review(["B-1"]), B: review([]), C: review(["B-1"]) };

	it("renders seat-facing files with seat letters and no model data", () => {
		const outputs = [
			renderReviewRequest({
				seat: "B",
				round: 2,
				seats: ledger.seats,
				taskFile: "/c/task.md",
				planFile: "/c/round-2/plan.md",
				responseFile: "/c/round-2/response.md",
				previousDecisionFile: "/c/round-1/decision.md",
				ledger,
			}),
			renderCrossExamRequest({
				seat: "B",
				round: 1,
				seatCount: 3,
				ledgerFile: "/c/round-1/ledger.md",
				planFile: "/c/round-1/plan.md",
				ledger,
				targets: ballotTargets(ledger, "B"),
				ownOpen: openFindingsOf(ledger, "B"),
			}),
			renderLedger({ round: 1, ledger, reviews }),
			renderDecision({ round: 1, decision: "revise", ledger: tally(ledger, 1) }),
			renderRepairRequest({ seat: "B", round: 1, phase: "review", error: "bad", requestFile: "/c/r.md" }),
		];
		for (const output of outputs) {
			for (const model of manifestModels) assert.equal(output.includes(model), false, model);
			assert.match(output, /seat|Seat|A\/B-1/);
		}
		assert.match(outputs[1] ?? "", /- A\/B-1: B-1 needs a test/);
		assert.match(outputs[1] ?? "", /at least 2 of the 3 seats/);
		assert.match(outputs[2] ?? "", /## Up for a vote\n- A\/B-1/);
	});

	it("keeps the seat-to-model map in the host-only record", () => {
		const state: CouncilState = {
			version: 1,
			seats: ["A", "B", "C"],
			maxRounds: 3,
			budgetUsed: 1,
			ledger: tally(ledger, 1),
			rounds: [],
			overrides: [{ id: "A/B-1", reason: "user accepts", round: 1 }],
			escalations: [],
		};
		const record = renderRecord({
			state,
			seatModels: { A: manifestModels[0], B: manifestModels[1], C: "openai/gpt-6-luna" },
			plannerModel: "anthropic/claude-opus-5-5",
			excluded: [],
		});
		assert.match(record, /- A: openai\/gpt-6-astra:high/);
		assert.match(record, /A\/B-1 \(round 1\): user accepts/);
	});
});
