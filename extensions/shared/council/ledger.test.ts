import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyBallots,
	applyResponse,
	applyReviews,
	ballotTargets,
	type CouncilLedger,
	createLedger,
	decide,
	dismisses,
	type FindingStatus,
	findingsWithStatus,
	needsCrossExam,
	overrideFinding,
	type SeatBallot,
	type SeatReview,
	tally,
	type VoteKind,
} from "./ledger.ts";
import { SEAT_LETTERS, type SeatLetter } from "./roster.ts";

function review(blocking: string[] = [], resolved: string[] = []): SeatReview {
	return {
		verdict: blocking.length > 0 ? "revise" : "approve",
		blocking: blocking.map((id) => ({ id, text: `${id} text` })),
		suggestions: [],
		resolved: resolved.map((id) => ({ id, summary: `${id} fixed` })),
	};
}

function approveAll(ledger: CouncilLedger): Partial<Record<SeatLetter, SeatReview>> {
	return Object.fromEntries(ledger.seats.map((seat) => [seat, review()]));
}

function ballots(
	ledger: CouncilLedger,
	votes: Partial<Record<SeatLetter, VoteKind>>,
	withdrawn: Partial<Record<SeatLetter, string[]>> = {},
): Partial<Record<SeatLetter, SeatBallot>> {
	return Object.fromEntries(
		ledger.seats.map((seat) => [
			seat,
			{
				votes: ballotTargets(ledger, seat).map((finding) => {
					const vote = votes[seat] ?? "concur";
					return vote === "object" ? { id: finding.id, vote, evidence: "repo evidence" } : { id: finding.id, vote };
				}),
				withdrawn: (withdrawn[seat] ?? []).map((id) => ({ id })),
			},
		]),
	);
}

function statusOf(ledger: CouncilLedger, id: string): FindingStatus | undefined {
	return ledger.findings.find((finding) => finding.id === id)?.status;
}

/** Seat A raises B-1, then every other seat casts `vote`. */
function voteOnOneFinding(seatCount: number, objectors: number, otherVote: VoteKind = "concur"): CouncilLedger {
	const seats = SEAT_LETTERS.slice(0, seatCount);
	let ledger = createLedger(seats);
	ledger = applyReviews(ledger, { ...approveAll(ledger), A: review(["B-1"]) }, 1);
	const votes: Partial<Record<SeatLetter, VoteKind>> = {};
	seats.slice(1).forEach((seat, index) => {
		votes[seat] = index < objectors ? "object" : otherVote;
	});
	if (needsCrossExam(ledger)) ledger = applyBallots(ledger, ballots(ledger, votes), 1);
	return tally(ledger, 1);
}

describe("council ledger", () => {
	it("dismisses only when 2 × objections > seats", () => {
		const cases: { seats: number; objectors: number; status: FindingStatus }[] = [
			{ seats: 1, objectors: 0, status: "binding" },
			{ seats: 2, objectors: 0, status: "binding" },
			{ seats: 2, objectors: 1, status: "binding" },
			{ seats: 3, objectors: 1, status: "binding" },
			{ seats: 3, objectors: 2, status: "dismissed" },
			{ seats: 5, objectors: 2, status: "binding" },
			{ seats: 5, objectors: 3, status: "dismissed" },
			{ seats: 5, objectors: 4, status: "dismissed" },
		];
		for (const { seats, objectors, status } of cases) {
			assert.equal(statusOf(voteOnOneFinding(seats, objectors), "A/B-1"), status, `${seats} seats, ${objectors}`);
		}
		assert.equal(dismisses(2, 4), false, "a tie binds");
		assert.equal(dismisses(3, 4), true);
	});

	it("keeps findings binding on abstentions and ignores concurrence", () => {
		assert.equal(statusOf(voteOnOneFinding(3, 1, "abstain"), "A/B-1"), "binding");
		assert.equal(statusOf(voteOnOneFinding(5, 2, "abstain"), "A/B-1"), "binding");
		assert.equal(statusOf(voteOnOneFinding(3, 0, "concur"), "A/B-1"), "binding");
	});

	it("skips cross-examination for one seat or nothing up for a vote", () => {
		const solo = applyReviews(createLedger(["A"]), { A: review(["B-1"]) }, 1);
		assert.equal(needsCrossExam(solo), false);
		const quiet = applyReviews(createLedger(["A", "B"]), { A: review(), B: review() }, 1);
		assert.equal(needsCrossExam(quiet), false);
		const voting = applyReviews(createLedger(["A", "B"]), { A: review(["B-1"]), B: review() }, 1);
		assert.equal(needsCrossExam(voting), true);
		assert.deepEqual(
			ballotTargets(voting, "A").map((finding) => finding.id),
			[],
		);
		assert.deepEqual(
			ballotTargets(voting, "B").map((finding) => finding.id),
			["A/B-1"],
		);
	});

	it("lets only the raising seat withdraw or resolve", () => {
		let ledger = createLedger(["A", "B", "C"]);
		ledger = applyReviews(ledger, { A: review(["B-1"]), B: review(["B-1"]), C: review() }, 1);
		assert.throws(() => applyBallots(ledger, ballots(ledger, {}, { B: ["A/B-1"] }), 1), /only the raising seat/);
		const withdrawn = tally(applyBallots(ledger, ballots(ledger, {}, { A: ["A/B-1"] }), 1), 1);
		assert.equal(statusOf(withdrawn, "A/B-1"), "withdrawn");
		assert.equal(statusOf(withdrawn, "B/B-1"), "binding");

		assert.throws(() => applyReviews(withdrawn, { A: review(), B: review(), C: review([], ["B-1"]) }, 2), /no open/);
		const resolved = applyReviews(withdrawn, { A: review(), B: review([], ["B-1"]), C: review() }, 2);
		assert.equal(statusOf(resolved, "B/B-1"), "resolved");
		assert.equal(statusOf(resolved, "A/B-1"), "withdrawn");
	});

	it("reopens a dismissed finding as pending when its seat raises it again", () => {
		const dismissed = voteOnOneFinding(3, 2);
		assert.equal(statusOf(dismissed, "A/B-1"), "dismissed");
		const reopened = applyReviews(dismissed, { A: review(["B-1"]), B: review(), C: review() }, 2);
		assert.equal(statusOf(reopened, "A/B-1"), "pending");
		assert.deepEqual(reopened.findings[0]?.votes, []);
	});

	it("puts a rebutted finding up for a re-vote and escalates a second rebuttal", () => {
		const first = voteOnOneFinding(3, 1);
		const rebutted = applyResponse(first, [{ id: "A/B-1", kind: "rebutted", text: "evidence" }], 2);
		assert.equal(rebutted.kind, "accepted");
		if (rebutted.kind !== "accepted") return;
		assert.equal(statusOf(rebutted.ledger, "A/B-1"), "pending");
		let ledger = applyReviews(rebutted.ledger, { A: review(["B-1"]), B: review(), C: review() }, 2);
		ledger = tally(applyBallots(ledger, ballots(ledger, { B: "object", C: "abstain" }), 2), 2);
		assert.equal(statusOf(ledger, "A/B-1"), "binding");

		const second = applyResponse(ledger, [{ id: "A/B-1", kind: "rebutted", text: "again" }], 3);
		assert.deepEqual(second, {
			kind: "escalate",
			escalations: [{ id: "A/B-1", reason: "second-rebuttal", text: "again" }],
		});
	});

	it("escalates conflicts and validates response coverage", () => {
		let ledger = createLedger(["A", "B"]);
		ledger = tally(applyReviews(ledger, { A: review(["B-1"]), B: review(["B-1"]) }, 1), 1);
		assert.equal(findingsWithStatus(ledger, "binding").length, 2);
		const conflict = applyResponse(
			ledger,
			[
				{ id: "A/B-1", kind: "conflicts-with", conflictsWith: "B/B-1", text: "both cannot hold" },
				{ id: "B/B-1", kind: "addressed", text: "STEP-2" },
			],
			2,
		);
		assert.equal(conflict.kind, "escalate");
		const errors = [
			[{ id: "A/B-1", kind: "addressed", text: "x" }],
			[
				{ id: "A/B-1", kind: "addressed", text: "x" },
				{ id: "A/B-1", kind: "addressed", text: "x" },
				{ id: "B/B-1", kind: "addressed", text: "x" },
			],
			[
				{ id: "A/B-1", kind: "addressed", text: "x" },
				{ id: "B/B-1", kind: "addressed", text: "x" },
				{ id: "C/B-9", kind: "addressed", text: "x" },
			],
			[
				{ id: "A/B-1", kind: "conflicts-with", conflictsWith: "A/B-1", text: "x" },
				{ id: "B/B-1", kind: "addressed", text: "x" },
			],
		] as const;
		for (const entries of errors) assert.equal(applyResponse(ledger, entries, 2).kind, "error");
	});

	it("keeps an overridden finding overridden when re-raised and lets override lead to approval", () => {
		const binding = voteOnOneFinding(3, 1);
		assert.equal(decide(binding, { allSeatsReplied: true, budgetRemaining: true }), "revise");
		assert.equal(decide(binding, { allSeatsReplied: true, budgetRemaining: false }), "exhausted");
		assert.equal(overrideFinding(binding, "A/B-1", " ", 1).ok, false);
		assert.equal(overrideFinding(binding, "A/B-9", "why", 1).ok, false);
		const overridden = overrideFinding(binding, "A/B-1", "user accepts the risk", 1);
		assert.ok(overridden.ok);
		assert.equal(statusOf(overridden.ledger, "A/B-1"), "overridden");
		assert.equal(overrideFinding(overridden.ledger, "A/B-1", "again", 1).ok, false);
		assert.equal(decide(overridden.ledger, { allSeatsReplied: true, budgetRemaining: true }), "approve");

		const reraised = applyReviews(overridden.ledger, { A: review(["B-1"]), B: review(), C: review() }, 2);
		assert.equal(statusOf(reraised, "A/B-1"), "overridden");
		assert.equal(reraised.findings[0]?.reraisedAfterOverride, 2);
	});

	it("approves only with every seat replied and nothing binding or pending", () => {
		const clean = applyReviews(createLedger(["A", "B"]), { A: review(), B: review() }, 1);
		assert.equal(decide(clean, { allSeatsReplied: true, budgetRemaining: false }), "approve");
		assert.equal(decide(clean, { allSeatsReplied: false, budgetRemaining: true }), "incomplete");
		const pending = applyReviews(clean, { A: review(["B-1"]), B: review() }, 2);
		assert.equal(decide(pending, { allSeatsReplied: true, budgetRemaining: true }), "incomplete");
	});

	it("never mutates its input ledger", () => {
		const ledger = applyReviews(createLedger(["A", "B", "C"]), { A: review(["B-1"]), B: review(), C: review() }, 1);
		const snapshot = structuredClone(ledger);
		tally(applyBallots(ledger, ballots(ledger, { B: "object", C: "object" }), 1), 1);
		assert.deepEqual(ledger, snapshot);
	});
});
