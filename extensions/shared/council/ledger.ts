/**
 * Pure council ledger: the finding lifecycle, ballots, tally, overrides, and
 * round decisions. Every transition returns a new ledger; callers persist it.
 *
 * A finding moves through pending → binding | dismissed | withdrawn |
 * resolved | overridden. Pending means "up for a vote": new, reopened, or
 * rebutted since the last vote. Only the raising seat resolves or withdraws
 * its finding, and a vote dismisses it only when 2 × objections > seats.
 */

import type { SeatLetter } from "./roster.ts";

export type FindingStatus = "pending" | "binding" | "dismissed" | "withdrawn" | "resolved" | "overridden";
export type VoteKind = "concur" | "object" | "abstain";

interface Vote {
	seat: SeatLetter;
	vote: VoteKind;
	evidence?: string;
}

export interface CouncilFinding {
	/** Namespaced ID, such as `A/B-1`. */
	id: string;
	seat: SeatLetter;
	text: string;
	status: FindingStatus;
	raisedRound: number;
	updatedRound: number;
	rebuttals: number;
	rebuttal?: string;
	/** Raising seat's resolution summary or withdrawal reason. */
	resolution?: string;
	/** Ballots from the most recent vote on this finding. */
	votes: Vote[];
	overrideReason?: string;
	/** Latest round in which the seat re-raised this finding after an override. */
	reraisedAfterOverride?: number;
}

interface CouncilSuggestion {
	id: string;
	seat: SeatLetter;
	text: string;
	round: number;
}

export interface CouncilLedger {
	seats: SeatLetter[];
	findings: CouncilFinding[];
	suggestions: CouncilSuggestion[];
}

/** One seat's validated review, with local `B-n` / `S-n` IDs and sanitized text. */
export interface SeatReview {
	verdict: "approve" | "revise";
	blocking: { id: string; text: string }[];
	suggestions: { id: string; text: string }[];
	resolved: { id: string; summary: string }[];
}

/** One seat's validated ballot, with namespaced IDs. */
export interface SeatBallot {
	votes: { id: string; vote: VoteKind; evidence?: string }[];
	withdrawn: { id: string; reason?: string }[];
}

export type ResponseKind = "addressed" | "rebutted" | "conflicts-with";

export interface ResponseEntry {
	id: string;
	kind: ResponseKind;
	/** The other binding finding named by `conflicts-with`. */
	conflictsWith?: string;
	text: string;
}

export interface Escalation {
	id: string;
	reason: "conflict" | "second-rebuttal";
	conflictsWith?: string;
	text: string;
}

type ResponseOutcome =
	| { kind: "error"; error: string }
	| { kind: "escalate"; escalations: Escalation[] }
	| { kind: "accepted"; ledger: CouncilLedger };

export type CouncilDecision = "approve" | "revise" | "exhausted";

const OPEN: ReadonlySet<FindingStatus> = new Set(["pending", "binding"]);

export function createLedger(seats: readonly SeatLetter[]): CouncilLedger {
	return { seats: [...seats], findings: [], suggestions: [] };
}

function findingId(seat: SeatLetter, localId: string): string {
	return `${seat}/${localId}`;
}

export function openFindingsOf(ledger: CouncilLedger, seat: SeatLetter): CouncilFinding[] {
	return ledger.findings.filter((finding) => finding.seat === seat && OPEN.has(finding.status));
}

export function findingsWithStatus(ledger: CouncilLedger, status: FindingStatus): CouncilFinding[] {
	return ledger.findings.filter((finding) => finding.status === status);
}

/** Findings another seat must vote on: pending findings it did not raise. */
export function ballotTargets(ledger: CouncilLedger, seat: SeatLetter): CouncilFinding[] {
	return findingsWithStatus(ledger, "pending").filter((finding) => finding.seat !== seat);
}

/** Cross-examination runs only with at least two seats and something up for a vote. */
export function needsCrossExam(ledger: CouncilLedger): boolean {
	return ledger.seats.length >= 2 && findingsWithStatus(ledger, "pending").length > 0;
}

function find(ledger: CouncilLedger, id: string): CouncilFinding | undefined {
	return ledger.findings.find((finding) => finding.id === id);
}

/**
 * Apply the planner's response to the previous round's binding findings.
 * Every binding finding needs exactly one answer. A conflict or a second
 * rebuttal escalates to the user without changing the ledger.
 */
export function applyResponse(
	ledger: CouncilLedger,
	entries: readonly ResponseEntry[],
	round: number,
): ResponseOutcome {
	const binding = new Set(findingsWithStatus(ledger, "binding").map((finding) => finding.id));
	const answered = new Set<string>();
	for (const entry of entries) {
		if (!binding.has(entry.id)) return { kind: "error", error: `Response names ${entry.id}, which is not binding.` };
		if (answered.has(entry.id)) return { kind: "error", error: `Response answers ${entry.id} more than once.` };
		answered.add(entry.id);
		if (entry.kind === "conflicts-with") {
			if (!entry.conflictsWith || !binding.has(entry.conflictsWith) || entry.conflictsWith === entry.id) {
				return {
					kind: "error",
					error: `${entry.id} conflicts-with must name another binding finding.`,
				};
			}
		}
	}
	const missing = [...binding].filter((id) => !answered.has(id));
	if (missing.length > 0) return { kind: "error", error: `Response does not answer ${missing.join(", ")}.` };

	const escalations: Escalation[] = [];
	for (const entry of entries) {
		if (entry.kind === "conflicts-with") {
			escalations.push({ id: entry.id, reason: "conflict", conflictsWith: entry.conflictsWith, text: entry.text });
		} else if (entry.kind === "rebutted" && (find(ledger, entry.id)?.rebuttals ?? 0) >= 1) {
			escalations.push({ id: entry.id, reason: "second-rebuttal", text: entry.text });
		}
	}
	if (escalations.length > 0) return { kind: "escalate", escalations };

	const next = structuredClone(ledger);
	for (const entry of entries) {
		if (entry.kind !== "rebutted") continue;
		const finding = find(next, entry.id);
		if (!finding) continue;
		finding.status = "pending";
		finding.rebuttals += 1;
		finding.rebuttal = entry.text;
		finding.updatedRound = round;
	}
	return { kind: "accepted", ledger: next };
}

/** Merge validated reviews: resolve, reopen, re-raise, and add findings by raising seat only. */
export function applyReviews(
	ledger: CouncilLedger,
	reviews: Readonly<Partial<Record<SeatLetter, SeatReview>>>,
	round: number,
): CouncilLedger {
	const next = structuredClone(ledger);
	for (const seat of next.seats) {
		const review = reviews[seat];
		if (!review) throw new Error(`Seat ${seat} has no review for round ${round}.`);
		for (const resolved of review.resolved) {
			const finding = find(next, findingId(seat, resolved.id));
			if (!finding || !OPEN.has(finding.status)) {
				throw new Error(`Seat ${seat} cannot resolve ${resolved.id}; it has no open finding with that ID.`);
			}
			finding.status = "resolved";
			finding.resolution = resolved.summary;
			finding.updatedRound = round;
		}
		for (const blocking of review.blocking) {
			const id = findingId(seat, blocking.id);
			const finding = find(next, id);
			if (!finding) {
				next.findings.push({
					id,
					seat,
					text: blocking.text,
					status: "pending",
					raisedRound: round,
					updatedRound: round,
					rebuttals: 0,
					votes: [],
				});
			} else if (finding.status === "overridden") {
				finding.reraisedAfterOverride = round;
			} else if (OPEN.has(finding.status)) {
				finding.text = blocking.text;
			} else {
				finding.status = "pending";
				finding.text = blocking.text;
				finding.updatedRound = round;
				finding.votes = [];
				delete finding.resolution;
			}
		}
		for (const suggestion of review.suggestions) {
			next.suggestions.push({ id: findingId(seat, suggestion.id), seat, text: suggestion.text, round });
		}
	}
	return next;
}

/** Record votes on pending findings and the raising seats' withdrawals. */
export function applyBallots(
	ledger: CouncilLedger,
	ballots: Readonly<Partial<Record<SeatLetter, SeatBallot>>>,
	round: number,
): CouncilLedger {
	const next = structuredClone(ledger);
	for (const finding of findingsWithStatus(next, "pending")) finding.votes = [];
	for (const seat of next.seats) {
		const ballot = ballots[seat];
		if (!ballot) throw new Error(`Seat ${seat} has no ballot for round ${round}.`);
		for (const withdrawal of ballot.withdrawn) {
			const finding = find(next, withdrawal.id);
			if (!finding || finding.seat !== seat || !OPEN.has(finding.status)) {
				throw new Error(
					`Seat ${seat} cannot withdraw ${withdrawal.id}; only the raising seat withdraws open findings.`,
				);
			}
			finding.status = "withdrawn";
			if (withdrawal.reason) finding.resolution = withdrawal.reason;
			finding.updatedRound = round;
		}
		for (const vote of ballot.votes) {
			const finding = find(next, vote.id);
			if (!finding || finding.seat === seat) {
				throw new Error(`Seat ${seat} cannot vote on ${vote.id}.`);
			}
			if (finding.status !== "pending") continue;
			finding.votes.push({ seat, vote: vote.vote, ...(vote.evidence ? { evidence: vote.evidence } : undefined) });
		}
	}
	return next;
}

/** Whether a vote dismisses a finding: strictly more than half of all seats object. */
export function dismisses(objections: number, seats: number): boolean {
	return 2 * objections > seats;
}

/** Settle every pending finding: dismissed on a strict-majority objection, otherwise binding. */
export function tally(ledger: CouncilLedger, round: number): CouncilLedger {
	const next = structuredClone(ledger);
	for (const finding of findingsWithStatus(next, "pending")) {
		const objections = finding.votes.filter((vote) => vote.vote === "object").length;
		finding.status = dismisses(objections, next.seats.length) ? "dismissed" : "binding";
		finding.updatedRound = round;
	}
	return next;
}

/** The user's override turns one binding finding into `overridden`. */
export function overrideFinding(
	ledger: CouncilLedger,
	id: string,
	reason: string,
	round: number,
): { ok: true; ledger: CouncilLedger } | { ok: false; error: string } {
	if (!reason.trim()) return { ok: false, error: "An override needs a reason." };
	const finding = find(ledger, id);
	if (!finding) return { ok: false, error: `No finding ${id} exists.` };
	if (finding.status !== "binding") {
		return { ok: false, error: `${id} is ${finding.status}; only a binding finding can be overridden.` };
	}
	const next = structuredClone(ledger);
	const target = find(next, id);
	if (!target) return { ok: false, error: `No finding ${id} exists.` };
	target.status = "overridden";
	target.overrideReason = reason.trim();
	target.updatedRound = round;
	return { ok: true, ledger: next };
}

/**
 * Decide a completed round. Approval needs a validated reply from every seat
 * and no binding or pending findings.
 */
export function decide(
	ledger: CouncilLedger,
	input: { allSeatsReplied: boolean; budgetRemaining: boolean },
): CouncilDecision | "incomplete" {
	if (!input.allSeatsReplied || findingsWithStatus(ledger, "pending").length > 0) return "incomplete";
	if (findingsWithStatus(ledger, "binding").length > 0) return input.budgetRemaining ? "revise" : "exhausted";
	return "approve";
}
