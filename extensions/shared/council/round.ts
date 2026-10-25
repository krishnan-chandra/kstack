/**
 * One council round under the exclusive council lock: snapshot inputs, apply
 * the planner response, ask every seat in parallel with one repair ask,
 * publish the ledger, run cross-examination when needed, tally, and decide.
 *
 * Progress persists in `state.json` after every validated reply, so a
 * cancelled or failed round resumes by asking only seats without a validated
 * reply, against the same snapshots.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import {
	applyBallots,
	applyResponse,
	applyReviews,
	ballotTargets,
	type CouncilDecision,
	decide,
	type Escalation,
	findingsWithStatus,
	needsCrossExam,
	openFindingsOf,
	overrideFinding,
	type SeatBallot,
	type SeatReview,
	tally,
} from "./ledger.ts";
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
} from "./protocol.ts";
import type { SeatLetter } from "./roster.ts";
import {
	type CouncilPhase,
	type CouncilRoundState,
	type CouncilState,
	councilPaths,
	readState,
	sha256,
	withCouncilLock,
	writeFileAtomic,
	writeState,
} from "./store.ts";

export interface SeatAsk {
	seat: SeatLetter;
	promptFile: string;
	outputFile: string;
	timeoutMs: number;
	outputCapBytes: number;
	signal?: AbortSignal;
}

export type SeatAskResult =
	| { status: "completed"; output: string }
	| { status: "blocked" }
	| { status: "failed"; error: string }
	| { status: "aborted" };

export interface RoundDeps {
	askSeat(ask: SeatAsk): Promise<SeatAskResult>;
	now?(): Date;
	pidAlive?(pid: number): boolean;
}

/** Host-only data for `record.md` and failure messages. */
export interface CouncilRecordInfo {
	seatModels: Partial<Record<SeatLetter, string>>;
	seatPanes: Partial<Record<SeatLetter, string>>;
	plannerModel: string;
	excluded: string[];
}

export interface RoundInput {
	dir: string;
	planFile: string;
	taskFile?: string;
	responseFile?: string;
	verify?: boolean;
	timeoutMs: number;
	info: CouncilRecordInfo;
	signal?: AbortSignal;
}

interface SeatFailure {
	seat: SeatLetter;
	pane?: string;
	error: string;
}

interface RoundResult {
	status: "complete" | "incomplete" | "escalated" | "failed";
	exitCode: 0 | 1;
	round?: number;
	kind?: CouncilRoundState["kind"];
	resumed?: boolean;
	decision?: CouncilDecision | "escalate";
	budget?: { used: number; max: number };
	binding?: string[];
	ledgerFile?: string;
	decisionFile?: string;
	recordFile?: string;
	approvedPlan?: string;
	approvedSha256?: string;
	planChangedSinceSnapshot?: boolean;
	escalations?: Escalation[];
	failures?: SeatFailure[];
	cancelled?: boolean;
	error?: string;
}

function failed(error: string): RoundResult {
	return { status: "failed", exitCode: 1, error };
}

function liveSha(path: string): string | undefined {
	try {
		return sha256(readFileSync(path));
	} catch {
		return undefined;
	}
}

function lastRound(state: CouncilState): CouncilRoundState | undefined {
	return state.rounds.at(-1);
}

function lastCompleteRound(state: CouncilState): CouncilRoundState | undefined {
	return state.rounds.findLast((round) => round.phase === "complete");
}

function describeFailure(result: Exclude<SeatAskResult, { status: "completed" }>, pane: string | undefined): string {
	const where = pane ? ` Inspect pane ${pane}.` : "";
	if (result.status === "blocked") return `The seat is waiting at a dialog.${where}`;
	if (result.status === "aborted") return "Cancelled.";
	return `${result.error}${where && !result.error.includes("Inspect pane") ? where : ""}`;
}

/** Run or resume one council round. Never throws for seat or input failures. */
export async function runCouncilRound(input: RoundInput, deps: RoundDeps): Promise<RoundResult> {
	const locked = await withCouncilLock(input.dir, () => runLocked(input, deps), deps.pidAlive);
	return locked.ok ? locked.value : failed(locked.error);
}

type RoundStart = { ok: true; state: CouncilState; round: CouncilRoundState; resumed: boolean } | RoundResult;

async function runLocked(input: RoundInput, deps: RoundDeps): Promise<RoundResult> {
	let state: CouncilState;
	try {
		state = readState(input.dir);
	} catch (error) {
		return failed(`Could not read the council state: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		const started = startOrResume(state, input, deps);
		if (!("ok" in started)) return started;
		return await driveRound(started.state, started.round, started.resumed, input, deps);
	} catch (error) {
		// Progress persisted before the failure; a rerun resumes from state.json.
		return failed(`The council round stopped: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function startOrResume(state: CouncilState, input: RoundInput, deps: RoundDeps): RoundStart {
	const previous = lastRound(state);
	if (previous && previous.phase !== "complete") return { ok: true, state, round: previous, resumed: true };
	const paths = councilPaths(input.dir);
	const kind: CouncilRoundState["kind"] = input.verify ? "verify" : "budgeted";
	const remaining = state.maxRounds - state.budgetUsed;
	if (kind === "verify" && remaining > 0) {
		return failed(`--verify runs only after the budgeted rounds are used; ${remaining} budgeted round(s) remain.`);
	}
	if (kind === "budgeted" && remaining <= 0) {
		return failed(
			`All ${state.maxRounds} budgeted rounds are used. Run a --verify round, override a finding, or steer a seat.`,
		);
	}
	const number = (previous?.number ?? 0) + 1;
	const binding = findingsWithStatus(state.ledger, "binding").map((finding) => finding.id);
	let ledger = state.ledger;
	let responseText: string | undefined;
	if (input.responseFile !== undefined) {
		try {
			responseText = readFileSync(input.responseFile, "utf8");
		} catch (error) {
			return failed(`Could not read --response: ${error instanceof Error ? error.message : String(error)}`);
		}
		const entries = parsePlannerResponse(responseText);
		if (!entries.ok) return failed(entries.error);
		const outcome = applyResponse(state.ledger, entries.value, number);
		if (outcome.kind === "error") return failed(outcome.error);
		if (outcome.kind === "escalate") {
			const escalated: CouncilState = {
				...state,
				escalations: [...state.escalations, { round: number, escalations: outcome.escalations }],
			};
			writeState(input.dir, escalated);
			writeRecord(escalated, input);
			return {
				status: "escalated",
				exitCode: 0,
				decision: "escalate",
				escalations: outcome.escalations,
				budget: { used: state.budgetUsed, max: state.maxRounds },
				binding,
				recordFile: paths.record,
			};
		}
		ledger = outcome.ledger;
	} else if (binding.length > 0) {
		return failed(`--response is required to answer the binding findings: ${binding.join(", ")}.`);
	}
	let taskText: string;
	try {
		if (input.taskFile !== undefined) taskText = readFileSync(input.taskFile, "utf8");
		else if (existsSync(paths.task)) taskText = readFileSync(paths.task, "utf8");
		else return failed("--task is required for the first round.");
	} catch (error) {
		return failed(`Could not read the task: ${error instanceof Error ? error.message : String(error)}`);
	}
	let plan: Buffer;
	try {
		plan = readFileSync(input.planFile);
	} catch (error) {
		return failed(`Could not read --plan: ${error instanceof Error ? error.message : String(error)}`);
	}
	const roundPaths = paths.round(number);
	writeFileAtomic(paths.task, taskText);
	writeFileAtomic(roundPaths.plan, plan);
	if (responseText !== undefined) writeFileAtomic(roundPaths.response, responseText);
	const round: CouncilRoundState = {
		number,
		kind,
		phase: "review",
		planSha256: sha256(plan),
		taskSha256: sha256(taskText),
		...(responseText !== undefined ? { responseSha256: sha256(responseText) } : undefined),
		reviews: {},
		ballots: {},
		startedAt: (deps.now?.() ?? new Date()).toISOString(),
	};
	const next: CouncilState = {
		...state,
		ledger,
		budgetUsed: kind === "budgeted" ? state.budgetUsed + 1 : state.budgetUsed,
		rounds: [...state.rounds, round],
	};
	writeState(input.dir, next);
	return { ok: true, state: next, round, resumed: false };
}

type ParseFn<T> = (reply: string) => { ok: true; value: T } | { ok: false; error: string };

type PhaseOutcome<T> = { ok: true; value: T } | { ok: false; failure: SeatFailure; cancelled: boolean };

async function askWithRepair<T>(
	input: RoundInput,
	deps: RoundDeps,
	ask: { seat: SeatLetter; round: number; phase: CouncilPhase; validate: ParseFn<T> },
): Promise<PhaseOutcome<T>> {
	const paths = councilPaths(input.dir).round(ask.round);
	const pane = input.info.seatPanes[ask.seat];
	const attempt = async (promptFile: string, outputFile: string) =>
		deps.askSeat({
			seat: ask.seat,
			promptFile,
			outputFile,
			timeoutMs: input.timeoutMs,
			outputCapBytes: COUNCIL_OUTPUT_CAP_BYTES,
			...(input.signal ? { signal: input.signal } : undefined),
		});
	const requestFile = paths.request(ask.phase, ask.seat);
	const first = await attempt(requestFile, paths.reply(ask.phase, ask.seat));
	if (first.status !== "completed") {
		return {
			ok: false,
			failure: { seat: ask.seat, ...(pane ? { pane } : undefined), error: describeFailure(first, pane) },
			cancelled: first.status === "aborted",
		};
	}
	const parsed = ask.validate(first.output);
	if (parsed.ok) return parsed;
	const repairFile = paths.repairRequest(ask.phase, ask.seat);
	writeFileAtomic(
		repairFile,
		renderRepairRequest({ seat: ask.seat, round: ask.round, phase: ask.phase, error: parsed.error, requestFile }),
	);
	const second = await attempt(repairFile, paths.repairReply(ask.phase, ask.seat));
	if (second.status !== "completed") {
		return {
			ok: false,
			failure: { seat: ask.seat, ...(pane ? { pane } : undefined), error: describeFailure(second, pane) },
			cancelled: second.status === "aborted",
		};
	}
	const repaired = ask.validate(second.output);
	if (repaired.ok) return repaired;
	const where = pane ? ` Inspect pane ${pane}.` : "";
	return {
		ok: false,
		failure: {
			seat: ask.seat,
			...(pane ? { pane } : undefined),
			error: `The reply was still invalid after one repair: ${repaired.error}${where}`,
		},
		cancelled: false,
	};
}

function writeRecord(state: CouncilState, input: RoundInput): void {
	const paths = councilPaths(input.dir);
	writeFileAtomic(
		paths.record,
		renderRecord({
			state,
			seatModels: input.info.seatModels,
			plannerModel: input.info.plannerModel,
			excluded: input.info.excluded,
			approvedPlanFile: paths.approvedPlan,
		}),
	);
}

function incomplete(
	state: CouncilState,
	round: CouncilRoundState,
	resumed: boolean,
	failures: SeatFailure[],
	cancelled: boolean,
	input: RoundInput,
): RoundResult {
	return {
		status: "incomplete",
		exitCode: 1,
		round: round.number,
		kind: round.kind,
		resumed,
		budget: { used: state.budgetUsed, max: state.maxRounds },
		failures,
		...(cancelled ? { cancelled } : undefined),
		planChangedSinceSnapshot: liveSha(input.planFile) !== round.planSha256,
	};
}

async function runPhase<T>(
	state: CouncilState,
	round: CouncilRoundState,
	input: RoundInput,
	deps: RoundDeps,
	phase: CouncilPhase,
	seats: readonly SeatLetter[],
	validate: (seat: SeatLetter) => ParseFn<T>,
	store: (seat: SeatLetter, value: T) => void,
): Promise<{ failures: SeatFailure[]; cancelled: boolean }> {
	const failures: SeatFailure[] = [];
	let cancelled = false;
	await Promise.all(
		seats.map(async (seat) => {
			const outcome = await askWithRepair(input, deps, { seat, round: round.number, phase, validate: validate(seat) });
			if (outcome.ok) {
				store(seat, outcome.value);
				writeState(input.dir, state);
				return;
			}
			failures.push(outcome.failure);
			if (outcome.cancelled) cancelled = true;
		}),
	);
	failures.sort((left, right) => left.seat.localeCompare(right.seat));
	return { failures, cancelled };
}

async function driveRound(
	state: CouncilState,
	round: CouncilRoundState,
	resumed: boolean,
	input: RoundInput,
	deps: RoundDeps,
): Promise<RoundResult> {
	const paths = councilPaths(input.dir);
	const roundPaths = paths.round(round.number);
	const previousComplete = state.rounds.filter((entry) => entry.phase === "complete").at(-1);

	if (round.phase === "review") {
		const waiting = state.seats.filter((seat) => round.reviews[seat] === undefined);
		for (const seat of waiting) {
			writeFileAtomic(
				roundPaths.request("review", seat),
				renderReviewRequest({
					seat,
					round: round.number,
					seats: state.seats,
					taskFile: paths.task,
					planFile: roundPaths.plan,
					...(round.responseSha256 ? { responseFile: roundPaths.response } : undefined),
					...(previousComplete ? { previousDecisionFile: paths.round(previousComplete.number).decision } : undefined),
					ledger: state.ledger,
				}),
			);
		}
		const { failures, cancelled } = await runPhase<SeatReview>(
			state,
			round,
			input,
			deps,
			"review",
			waiting,
			(seat) => (reply) =>
				parseSeatReview(
					reply,
					openFindingsOf(state.ledger, seat).map((finding) => finding.id.slice(finding.id.indexOf("/") + 1)),
				),
			(seat, review) => {
				round.reviews[seat] = review;
			},
		);
		if (failures.length > 0) return incomplete(state, round, resumed, failures, cancelled, input);
		state.ledger = applyReviews(state.ledger, round.reviews, round.number);
		writeFileAtomic(
			roundPaths.ledger,
			renderLedger({ round: round.number, ledger: state.ledger, reviews: round.reviews }),
		);
		round.crossExam = needsCrossExam(state.ledger);
		round.phase = round.crossExam ? "cross-exam" : "tally";
		writeState(input.dir, state);
	}

	if (round.phase === "cross-exam") {
		const targets = (seat: SeatLetter) => ballotTargets(state.ledger, seat);
		const own = (seat: SeatLetter) => openFindingsOf(state.ledger, seat);
		for (const seat of state.seats) {
			if (round.ballots[seat] === undefined && targets(seat).length === 0)
				round.ballots[seat] = { votes: [], withdrawn: [] };
		}
		const waiting = state.seats.filter((seat) => round.ballots[seat] === undefined);
		for (const seat of waiting) {
			writeFileAtomic(
				roundPaths.request("cross-exam", seat),
				renderCrossExamRequest({
					seat,
					round: round.number,
					seatCount: state.seats.length,
					ledgerFile: roundPaths.ledger,
					planFile: roundPaths.plan,
					ledger: state.ledger,
					targets: targets(seat),
					ownOpen: own(seat),
				}),
			);
		}
		const { failures, cancelled } = await runPhase<SeatBallot>(
			state,
			round,
			input,
			deps,
			"cross-exam",
			waiting,
			(seat) => (reply) =>
				parseSeatBallot(
					reply,
					targets(seat).map((finding) => finding.id),
					own(seat).map((finding) => finding.id),
				),
			(seat, ballot) => {
				round.ballots[seat] = ballot;
			},
		);
		if (failures.length > 0) return incomplete(state, round, resumed, failures, cancelled, input);
		state.ledger = applyBallots(state.ledger, round.ballots, round.number);
		round.phase = "tally";
		writeState(input.dir, state);
	}

	if (round.phase === "tally") {
		state.ledger = tally(state.ledger, round.number);
		const allSeatsReplied =
			state.seats.every((seat) => round.reviews[seat] !== undefined) &&
			(!round.crossExam || state.seats.every((seat) => round.ballots[seat] !== undefined));
		const decision = decide(state.ledger, {
			allSeatsReplied,
			budgetRemaining: state.budgetUsed < state.maxRounds,
		});
		if (decision === "incomplete") return failed(`Round ${round.number} could not be decided; rerun it.`);
		writeFileAtomic(roundPaths.decision, renderDecision({ round: round.number, decision, ledger: state.ledger }));
		round.phase = "complete";
		round.decision = decision;
		round.completedAt = (deps.now?.() ?? new Date()).toISOString();
		state.decision = { round: round.number, decision };
		settleApproval(state, round, decision, input.dir);
		writeState(input.dir, state);
		writeRecord(state, input);
	}

	return completedResult(state, round, resumed, input);
}

/** Copy the reviewed snapshot on approval; drop a stale approval otherwise. */
function settleApproval(state: CouncilState, round: CouncilRoundState, decision: CouncilDecision, dir: string): void {
	const paths = councilPaths(dir);
	if (decision === "approve") {
		const plan = readFileSync(paths.round(round.number).plan);
		writeFileAtomic(paths.approvedPlan, plan);
		state.approved = { round: round.number, sha256: sha256(plan) };
		return;
	}
	delete state.approved;
	rmSync(paths.approvedPlan, { force: true });
}

function completedResult(
	state: CouncilState,
	round: CouncilRoundState,
	resumed: boolean,
	input: RoundInput,
): RoundResult {
	const paths = councilPaths(input.dir);
	const decision = state.decision?.decision ?? round.decision;
	return {
		status: "complete",
		exitCode: 0,
		round: round.number,
		kind: round.kind,
		resumed,
		...(decision ? { decision } : undefined),
		budget: { used: state.budgetUsed, max: state.maxRounds },
		binding: findingsWithStatus(state.ledger, "binding").map((finding) => finding.id),
		ledgerFile: paths.round(round.number).ledger,
		decisionFile: paths.round(round.number).decision,
		recordFile: paths.record,
		...(state.approved ? { approvedPlan: paths.approvedPlan, approvedSha256: state.approved.sha256 } : undefined),
		planChangedSinceSnapshot: liveSha(input.planFile) !== round.planSha256,
	};
}

interface OverrideInput {
	dir: string;
	id: string;
	reason: string;
	planFile?: string;
	info: CouncilRecordInfo;
}

/** Turn one binding finding into `overridden` and re-derive the current decision. */
export async function overrideCouncilFinding(
	input: OverrideInput,
	deps: Pick<RoundDeps, "pidAlive"> = {},
): Promise<RoundResult> {
	const locked = await withCouncilLock(
		input.dir,
		async (): Promise<RoundResult> => {
			let state: CouncilState;
			try {
				state = readState(input.dir);
			} catch (error) {
				return failed(`Could not read the council state: ${error instanceof Error ? error.message : String(error)}`);
			}
			const current = lastRound(state);
			if (current && current.phase !== "complete") {
				return failed(`Round ${current.number} is incomplete; rerun it before overriding a finding.`);
			}
			const round = lastCompleteRound(state);
			if (!round) return failed("No completed round has findings to override.");
			const result = overrideFinding(state.ledger, input.id, input.reason, round.number);
			if (!result.ok) return failed(result.error);
			state.ledger = result.ledger;
			state.overrides = [...state.overrides, { id: input.id, reason: input.reason.trim(), round: round.number }];
			const decision = decide(state.ledger, {
				allSeatsReplied: true,
				budgetRemaining: state.budgetUsed < state.maxRounds,
			});
			if (decision === "incomplete") return failed("The council has pending findings; rerun the round.");
			state.decision = { round: round.number, decision };
			settleApproval(state, round, decision, input.dir);
			writeState(input.dir, state);
			const recordInput: RoundInput = {
				dir: input.dir,
				planFile: input.planFile ?? "",
				timeoutMs: 0,
				info: input.info,
			};
			writeRecord(state, recordInput);
			const outcome = completedResult(state, round, false, recordInput);
			if (input.planFile === undefined) delete outcome.planChangedSinceSnapshot;
			return outcome;
		},
		deps.pidAlive,
	);
	return locked.ok ? locked.value : failed(locked.error);
}
