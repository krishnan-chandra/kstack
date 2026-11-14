/**
 * One implementation-review round on the council's opened seats under the
 * exclusive council lock: snapshot all bundle inputs, ask every seat in
 * parallel with one repair ask, and publish `verdict.md`.
 *
 * Unlike generic `fanout`, this attaches to the existing council seats in the
 * caller's tab and never creates a background tab or starts duplicate agents.
 */

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type BoundaryValue, isNumber, isObject } from "../validation.ts";
import type { SeatReview } from "./ledger.ts";
import {
	COUNCIL_OUTPUT_CAP_BYTES,
	parseSeatReview,
	renderImplReviewRequest,
	renderImplSeatCritique,
	renderImplVerdict,
	renderRepairRequest,
} from "./protocol.ts";
import type { SeatLetter } from "./roster.ts";
import type { RoundDeps, SeatAskResult } from "./round.ts";
import { sha256, withCouncilLock, writeFileAtomic } from "./store.ts";

interface ImplReviewRoundState {
	number: number;
	phase: "review" | "complete";
	workstreamCwd: string;
	hasPlaybook: boolean;
	inputsSha256: string;
	diffSha256: string;
	ledgerSha256: string;
	reviews: Partial<Record<SeatLetter, SeatReview>>;
	decision?: "approve" | "revise" | "exhausted";
	startedAt: string;
	completedAt?: string;
}

interface ImplReviewState {
	version: 1;
	seats: SeatLetter[];
	seatModels: Partial<Record<SeatLetter, string>>;
	maxRounds: number;
	rounds: ImplReviewRoundState[];
}

interface ImplSeatFailure {
	seat: SeatLetter;
	pane?: string;
	error: string;
}

interface ImplReviewInput {
	dir: string;
	bundleDir: string;
	workstreamCwd: string;
	seats: readonly SeatLetter[];
	seatModels: Readonly<Partial<Record<SeatLetter, string>>>;
	maxRounds: number;
	timeoutMs: number;
	seatPanes: Readonly<Partial<Record<SeatLetter, string>>>;
	signal?: AbortSignal;
}

interface ImplReviewResult {
	status: "complete" | "incomplete" | "failed";
	exitCode: 0 | 1;
	round?: number;
	resumed?: boolean;
	decision?: "approve" | "revise" | "exhausted";
	budget?: { used: number; max: number };
	blocking?: string[];
	verdictFile?: string;
	seatFiles?: Partial<Record<SeatLetter, string>>;
	failures?: ImplSeatFailure[];
	cancelled?: boolean;
	error?: string;
}

const REQUIRED_BUNDLE_FILES = [
	"task.md",
	"approved-plan.md",
	"execution-ledger.md",
	"diff.patch",
	"vcs-policy.md",
] as const;

function failed(error: string): ImplReviewResult {
	return { status: "failed", exitCode: 1, error };
}

function implPaths(bundleDir: string) {
	return {
		state: join(bundleDir, "review-state.json"),
		verdict: join(bundleDir, "verdict.md"),
		task: join(bundleDir, "task.md"),
		approvedPlan: join(bundleDir, "approved-plan.md"),
		ledger: join(bundleDir, "execution-ledger.md"),
		diff: join(bundleDir, "diff.patch"),
		vcsPolicy: join(bundleDir, "vcs-policy.md"),
		playbookPointer: join(bundleDir, "playbook-path.txt"),
		seatOutput: (seat: SeatLetter) => join(bundleDir, `review-${seat.toLowerCase()}.md`),
		round(number: number) {
			const dir = join(bundleDir, `review-round-${number}`);
			const seatFile = (seat: SeatLetter, suffix: string) => join(dir, `review-${seat.toLowerCase()}${suffix}`);
			return {
				dir,
				task: join(dir, "task.md"),
				approvedPlan: join(dir, "approved-plan.md"),
				diff: join(dir, "diff.patch"),
				ledger: join(dir, "execution-ledger.md"),
				vcsPolicy: join(dir, "vcs-policy.md"),
				playbook: join(dir, "playbook.md"),
				verdict: join(dir, "verdict.md"),
				request: (seat: SeatLetter) => seatFile(seat, ".request.md"),
				reply: (seat: SeatLetter) => seatFile(seat, ".md"),
				repairRequest: (seat: SeatLetter) => seatFile(seat, ".repair.request.md"),
				repairReply: (seat: SeatLetter) => seatFile(seat, ".repair.md"),
			};
		},
	};
}

function readImplState(path: string): ImplReviewState {
	const parsed: BoundaryValue = JSON.parse(readFileSync(path, "utf8"));
	if (!isObject(parsed) || Array.isArray(parsed) || parsed === null) {
		throw new Error("review-state.json is not a JSON object.");
	}
	if (!("version" in parsed) || parsed.version !== 1) {
		throw new Error("review-state.json has an unsupported version.");
	}
	if (
		!("seats" in parsed) ||
		!Array.isArray(parsed.seats) ||
		!("seatModels" in parsed) ||
		!isObject(parsed.seatModels) ||
		parsed.seatModels === null ||
		Array.isArray(parsed.seatModels) ||
		!("rounds" in parsed) ||
		!Array.isArray(parsed.rounds) ||
		!("maxRounds" in parsed) ||
		!isNumber(parsed.maxRounds)
	) {
		throw new Error("review-state.json is malformed.");
	}
	// SAFETY: writeImplState owns review-state.json; version and structural keys are checked above.
	return parsed as ImplReviewState;
}

function writeImplState(path: string, state: ImplReviewState): void {
	writeFileAtomic(path, `${JSON.stringify(state, null, "\t")}\n`);
}

function sameSeatRoster(
	state: ImplReviewState,
	seats: readonly SeatLetter[],
	seatModels: Readonly<Partial<Record<SeatLetter, string>>>,
): boolean {
	if (state.seats.join() !== seats.join()) return false;
	return seats.every((seat) => (state.seatModels[seat] ?? "") === (seatModels[seat] ?? ""));
}

function describeFailure(result: Exclude<SeatAskResult, { status: "completed" }>, pane: string | undefined): string {
	const where = pane ? ` Inspect pane ${pane}.` : "";
	if (result.status === "blocked") return `The seat is waiting at a dialog.${where}`;
	if (result.status === "aborted") return "Cancelled.";
	const needsWhere = Boolean(where) && !result.error.includes("Inspect pane");
	return `${result.error}${needsWhere ? where : ""}`;
}

interface BundleValidated {
	canonicalCwd: string;
	taskBuffer: Buffer;
	approvedPlanBuffer: Buffer;
	diffBuffer: Buffer;
	ledgerBuffer: Buffer;
	vcsPolicyBuffer: Buffer;
	playbookBuffer?: Buffer;
	inputsSha256: string;
	diffSha256: string;
	ledgerSha256: string;
}

function validateBundle(
	bundleDir: string,
	workstreamCwd: string,
): { ok: true; value: BundleValidated } | { ok: false; error: string } {
	let canonicalCwd: string;
	try {
		if (!statSync(workstreamCwd).isDirectory()) {
			return { ok: false, error: `Workstream directory is not a directory: ${workstreamCwd}` };
		}
		canonicalCwd = realpathSync(workstreamCwd);
	} catch (error) {
		return {
			ok: false,
			error: `Could not inspect workstream directory ${workstreamCwd}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	for (const name of REQUIRED_BUNDLE_FILES) {
		const path = join(bundleDir, name);
		try {
			if (!statSync(path).isFile()) return { ok: false, error: `Bundle input is not a file: ${path}` };
		} catch {
			return { ok: false, error: `Missing required implementation-review input: ${path}` };
		}
	}
	const paths = implPaths(bundleDir);
	let canonicalPlaybookPath: string | undefined;
	let playbookBuffer: Buffer | undefined;
	if (existsSync(paths.playbookPointer)) {
		try {
			const trimmed = readFileSync(paths.playbookPointer, "utf8").trim();
			if (trimmed.length > 0) {
				if (!isAbsolute(trimmed) || !statSync(trimmed).isFile()) {
					return { ok: false, error: `playbook-path.txt must name an existing absolute file: ${trimmed}` };
				}
				canonicalPlaybookPath = realpathSync(trimmed);
				playbookBuffer = readFileSync(canonicalPlaybookPath);
			}
		} catch (error) {
			return {
				ok: false,
				error: `Could not read playbook-path.txt: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	try {
		const taskBuffer = readFileSync(paths.task);
		const approvedPlanBuffer = readFileSync(paths.approvedPlan);
		const diffBuffer = readFileSync(paths.diff);
		const ledgerBuffer = readFileSync(paths.ledger);
		const vcsPolicyBuffer = readFileSync(paths.vcsPolicy);
		const diffSha256 = sha256(diffBuffer);
		const ledgerSha256 = sha256(ledgerBuffer);
		const inputsSha256 = sha256(
			JSON.stringify({
				workstreamCwd: canonicalCwd,
				taskSha256: sha256(taskBuffer),
				approvedPlanSha256: sha256(approvedPlanBuffer),
				diffSha256,
				ledgerSha256,
				vcsPolicySha256: sha256(vcsPolicyBuffer),
				playbookPath: canonicalPlaybookPath ?? null,
				playbookSha256: playbookBuffer ? sha256(playbookBuffer) : null,
			}),
		);
		return {
			ok: true,
			value: {
				canonicalCwd,
				taskBuffer,
				approvedPlanBuffer,
				diffBuffer,
				ledgerBuffer,
				vcsPolicyBuffer,
				...(playbookBuffer ? { playbookBuffer } : undefined),
				inputsSha256,
				diffSha256,
				ledgerSha256,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: `Could not read implementation-review bundle: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function writeRoundSnapshots(bundleDir: string, roundNumber: number, bundle: BundleValidated): void {
	const roundPaths = implPaths(bundleDir).round(roundNumber);
	writeFileAtomic(roundPaths.task, bundle.taskBuffer);
	writeFileAtomic(roundPaths.approvedPlan, bundle.approvedPlanBuffer);
	writeFileAtomic(roundPaths.diff, bundle.diffBuffer);
	writeFileAtomic(roundPaths.ledger, bundle.ledgerBuffer);
	writeFileAtomic(roundPaths.vcsPolicy, bundle.vcsPolicyBuffer);
	if (bundle.playbookBuffer) {
		writeFileAtomic(roundPaths.playbook, bundle.playbookBuffer);
	} else {
		rmSync(roundPaths.playbook, { force: true });
	}
}

function priorFindingsForSeat(state: ImplReviewState, beforeRound: number, seat: SeatLetter) {
	const completed = state.rounds.filter((entry) => entry.phase === "complete" && entry.number < beforeRound);
	const lastComplete = completed.at(-1);
	const openFindings = lastComplete?.reviews[seat]?.blocking ?? [];
	const openIds = new Set(openFindings.map((finding) => finding.id));
	const closed = new Set<string>();
	for (const entry of completed) {
		for (const resolved of entry.reviews[seat]?.resolved ?? []) {
			if (!openIds.has(resolved.id)) closed.add(resolved.id);
		}
	}
	return { openFindings, closedIds: [...closed] };
}

async function askImplSeatWithRepair(
	input: ImplReviewInput,
	deps: RoundDeps,
	seat: SeatLetter,
	roundNumber: number,
	openIds: readonly string[],
): Promise<{ ok: true; value: SeatReview } | { ok: false; failure: ImplSeatFailure; cancelled: boolean }> {
	const roundPaths = implPaths(input.bundleDir).round(roundNumber);
	const pane = input.seatPanes[seat];
	const attempt = (promptFile: string, outputFile: string) =>
		deps.askSeat({
			seat,
			promptFile,
			outputFile,
			timeoutMs: input.timeoutMs,
			outputCapBytes: COUNCIL_OUTPUT_CAP_BYTES,
			...(input.signal ? { signal: input.signal } : undefined),
		});
	const requestFile = roundPaths.request(seat);
	const first = await attempt(requestFile, roundPaths.reply(seat));
	if (first.status !== "completed") {
		return {
			ok: false,
			failure: { seat, ...(pane ? { pane } : undefined), error: describeFailure(first, pane) },
			cancelled: first.status === "aborted",
		};
	}
	const parsed = parseSeatReview(first.output, openIds);
	if (parsed.ok) return parsed;

	const repairFile = roundPaths.repairRequest(seat);
	writeFileAtomic(
		repairFile,
		renderRepairRequest({
			seat,
			round: roundNumber,
			phase: "implementation review",
			error: parsed.error,
			requestFile,
		}),
	);
	const second = await attempt(repairFile, roundPaths.repairReply(seat));
	if (second.status !== "completed") {
		return {
			ok: false,
			failure: { seat, ...(pane ? { pane } : undefined), error: describeFailure(second, pane) },
			cancelled: second.status === "aborted",
		};
	}
	const repaired = parseSeatReview(second.output, openIds);
	if (repaired.ok) return repaired;
	const where = pane ? ` Inspect pane ${pane}.` : "";
	return {
		ok: false,
		failure: {
			seat,
			...(pane ? { pane } : undefined),
			error: `The reply was still invalid after one repair: ${repaired.error}${where}`,
		},
		cancelled: false,
	};
}

/** Run or resume one implementation-review round on the council's opened seats. */
export async function runCouncilImplReview(input: ImplReviewInput, deps: RoundDeps): Promise<ImplReviewResult> {
	if (input.seats.length === 0) return failed("The council manifest has no seats.");
	const locked = await withCouncilLock(input.dir, () => runImplLocked(input, deps), deps.pidAlive);
	return locked.ok ? locked.value : failed(locked.error);
}

async function runImplLocked(input: ImplReviewInput, deps: RoundDeps): Promise<ImplReviewResult> {
	const validated = validateBundle(input.bundleDir, input.workstreamCwd);
	if (!validated.ok) return failed(validated.error);
	const bundle = validated.value;
	const paths = implPaths(input.bundleDir);

	let state: ImplReviewState;
	if (existsSync(paths.state)) {
		try {
			state = readImplState(paths.state);
		} catch (error) {
			return failed(`Could not read review-state.json: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!sameSeatRoster(state, input.seats, input.seatModels)) {
			return failed("review-state.json belongs to a different council seat roster; use a fresh bundle directory.");
		}
	} else {
		state = {
			version: 1,
			seats: [...input.seats],
			seatModels: { ...input.seatModels },
			maxRounds: input.maxRounds,
			rounds: [],
		};
	}

	const nowIso = () => (deps.now?.() ?? new Date()).toISOString();
	const previous = state.rounds.at(-1);
	let round: ImplReviewRoundState;
	let resumed = false;

	if (previous && previous.phase !== "complete") {
		if (previous.inputsSha256 === bundle.inputsSha256) {
			round = previous;
			resumed = true;
		} else {
			previous.workstreamCwd = bundle.canonicalCwd;
			previous.hasPlaybook = bundle.playbookBuffer !== undefined;
			previous.inputsSha256 = bundle.inputsSha256;
			previous.diffSha256 = bundle.diffSha256;
			previous.ledgerSha256 = bundle.ledgerSha256;
			previous.reviews = {};
			previous.startedAt = nowIso();
			round = previous;
			writeRoundSnapshots(input.bundleDir, round.number, bundle);
			writeImplState(paths.state, state);
		}
	} else {
		if (state.rounds.length >= state.maxRounds) {
			return failed(
				`All ${state.maxRounds} implementation-review rounds are used. Present the open findings in ${paths.verdict} to the user.`,
			);
		}
		if (previous && previous.inputsSha256 === bundle.inputsSha256) {
			return failed(
				`Review inputs (including diff.patch and execution-ledger.md) are unchanged since review round ${previous.number}; regenerate diff.patch after addressing findings before rerunning.`,
			);
		}
		const number = (previous?.number ?? 0) + 1;
		writeRoundSnapshots(input.bundleDir, number, bundle);
		round = {
			number,
			phase: "review",
			workstreamCwd: bundle.canonicalCwd,
			hasPlaybook: bundle.playbookBuffer !== undefined,
			inputsSha256: bundle.inputsSha256,
			diffSha256: bundle.diffSha256,
			ledgerSha256: bundle.ledgerSha256,
			reviews: {},
			startedAt: nowIso(),
		};
		state.rounds.push(round);
		writeImplState(paths.state, state);
	}

	const roundPaths = paths.round(round.number);
	const previousComplete = state.rounds
		.filter((entry) => entry.phase === "complete" && entry.number < round.number)
		.at(-1);
	const waiting = state.seats.filter((seat) => round.reviews[seat] === undefined);

	for (const seat of waiting) {
		const { openFindings, closedIds } = priorFindingsForSeat(state, round.number, seat);
		writeFileAtomic(
			roundPaths.request(seat),
			renderImplReviewRequest({
				seat,
				round: round.number,
				seats: state.seats,
				workstreamCwd: round.workstreamCwd,
				taskFile: roundPaths.task,
				approvedPlanFile: roundPaths.approvedPlan,
				ledgerFile: roundPaths.ledger,
				diffFile: roundPaths.diff,
				vcsPolicyFile: roundPaths.vcsPolicy,
				...(round.hasPlaybook ? { playbookFile: roundPaths.playbook } : undefined),
				...(previousComplete ? { previousVerdictFile: paths.round(previousComplete.number).verdict } : undefined),
				openFindings,
				closedIds,
			}),
		);
	}

	const failures: ImplSeatFailure[] = [];
	let cancelled = false;
	await Promise.all(
		waiting.map(async (seat) => {
			const { openFindings } = priorFindingsForSeat(state, round.number, seat);
			const outcome = await askImplSeatWithRepair(
				input,
				deps,
				seat,
				round.number,
				openFindings.map((finding) => finding.id),
			);
			if (outcome.ok) {
				round.reviews[seat] = outcome.value;
				writeImplState(paths.state, state);
				return;
			}
			failures.push(outcome.failure);
			if (outcome.cancelled) cancelled = true;
		}),
	);
	failures.sort((left, right) => left.seat.localeCompare(right.seat));
	if (failures.length > 0) {
		return {
			status: "incomplete",
			exitCode: 1,
			round: round.number,
			resumed,
			budget: { used: state.rounds.length, max: state.maxRounds },
			failures,
			...(cancelled ? { cancelled: true } : undefined),
		};
	}

	const seatFiles: Partial<Record<SeatLetter, string>> = {};
	const blocking: string[] = [];
	for (const seat of state.seats) {
		const review = round.reviews[seat];
		if (!review) continue;
		const seatFile = paths.seatOutput(seat);
		writeFileAtomic(seatFile, renderImplSeatCritique(review));
		seatFiles[seat] = seatFile;
		for (const finding of review.blocking) blocking.push(`${seat}/${finding.id}`);
	}

	const verdictText = renderImplVerdict({ seats: state.seats, reviews: round.reviews });
	writeFileAtomic(roundPaths.verdict, verdictText);
	writeFileAtomic(paths.verdict, verdictText);

	let decision: "approve" | "revise" | "exhausted" = "approve";
	if (blocking.length > 0) {
		decision = state.rounds.length >= state.maxRounds ? "exhausted" : "revise";
	}
	round.phase = "complete";
	round.decision = decision;
	round.completedAt = nowIso();
	writeImplState(paths.state, state);

	return {
		status: "complete",
		exitCode: 0,
		round: round.number,
		resumed,
		decision,
		budget: { used: state.rounds.length, max: state.maxRounds },
		blocking,
		verdictFile: paths.verdict,
		seatFiles,
	};
}
