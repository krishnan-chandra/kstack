/**
 * Council directory layout, persisted state, atomic writes, and the exclusive
 * command lock. Every mutating council command (`open`, `round`, `override`,
 * `close`) runs under {@link withCouncilLock}.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BoundaryValue, isObject } from "../validation.ts";
import {
	type CouncilDecision,
	type CouncilLedger,
	createLedger,
	type Escalation,
	type SeatBallot,
	type SeatReview,
} from "./ledger.ts";
import type { SeatLetter } from "./roster.ts";

type RoundPhase = "review" | "cross-exam" | "tally" | "complete";
export type CouncilPhase = "review" | "cross-exam";

export interface CouncilRoundState {
	number: number;
	kind: "budgeted" | "verify";
	phase: RoundPhase;
	planSha256: string;
	taskSha256: string;
	responseSha256?: string;
	reviews: Partial<Record<SeatLetter, SeatReview>>;
	ballots: Partial<Record<SeatLetter, SeatBallot>>;
	crossExam?: boolean;
	decision?: CouncilDecision;
	startedAt: string;
	completedAt?: string;
}

export interface CouncilState {
	version: 1;
	seats: SeatLetter[];
	maxRounds: number;
	budgetUsed: number;
	ledger: CouncilLedger;
	rounds: CouncilRoundState[];
	/** Current decision; an override can change it after the round completed. */
	decision?: { round: number; decision: CouncilDecision };
	approved?: { round: number; sha256: string };
	overrides: { id: string; reason: string; round: number }[];
	escalations: { round: number; escalations: Escalation[] }[];
}

export function initialCouncilState(seats: readonly SeatLetter[], maxRounds: number): CouncilState {
	return {
		version: 1,
		seats: [...seats],
		maxRounds,
		budgetUsed: 0,
		ledger: createLedger(seats),
		rounds: [],
		overrides: [],
		escalations: [],
	};
}

export interface ManifestSeat {
	letter: SeatLetter;
	model: string;
	name: string;
	state: "starting" | "ready";
	paneId?: string;
	tabId?: string;
}

export interface CouncilManifest {
	version: 1;
	slug: string;
	cwd: string;
	tabId: string;
	callerPaneId: string;
	plannerModel: string;
	excluded: string[];
	/** Per-request seat timeout for council rounds. */
	timeoutMinutes: number;
	seats: ManifestSeat[];
}

export function councilPaths(dir: string) {
	return {
		dir,
		state: join(dir, "state.json"),
		manifest: join(dir, "manifest.json"),
		lock: join(dir, "council.lock"),
		task: join(dir, "task.md"),
		record: join(dir, "record.md"),
		approvedPlan: join(dir, "approved-plan.md"),
		round(number: number) {
			const roundDir = join(dir, `round-${number}`);
			const file = (phase: CouncilPhase, seat: SeatLetter, suffix: string) =>
				join(roundDir, `${phase}-${seat.toLowerCase()}${suffix}`);
			return {
				dir: roundDir,
				plan: join(roundDir, "plan.md"),
				response: join(roundDir, "response.md"),
				ledger: join(roundDir, "ledger.md"),
				decision: join(roundDir, "decision.md"),
				request: (phase: CouncilPhase, seat: SeatLetter) => file(phase, seat, ".request.md"),
				reply: (phase: CouncilPhase, seat: SeatLetter) => file(phase, seat, ".md"),
				repairRequest: (phase: CouncilPhase, seat: SeatLetter) => file(phase, seat, ".repair.request.md"),
				repairReply: (phase: CouncilPhase, seat: SeatLetter) => file(phase, seat, ".repair.md"),
			};
		},
	};
}

export function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Write through a sibling temp file and rename so readers never see a partial file. */
export function writeFileAtomic(path: string, content: string | Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, content, { mode: 0o600 });
	renameSync(temporary, path);
}

function readCouncilFile(path: string, label: string, keys: readonly string[]): object {
	const parsed: BoundaryValue = JSON.parse(readFileSync(path, "utf8"));
	if (!isObject(parsed) || Array.isArray(parsed) || parsed === null) throw new Error(`${label} is not a JSON object.`);
	if (!("version" in parsed) || parsed.version !== 1) throw new Error(`${label} has an unsupported version.`);
	for (const key of keys) if (!(key in parsed)) throw new Error(`${label} is missing ${key}.`);
	return parsed;
}

export function readState(dir: string): CouncilState {
	const value = readCouncilFile(councilPaths(dir).state, "state.json", ["seats", "ledger", "rounds", "maxRounds"]);
	// SAFETY: the council writes state.json itself; the version and key checks reject foreign files.
	return value as CouncilState;
}

export function writeState(dir: string, state: CouncilState): void {
	writeFileAtomic(councilPaths(dir).state, `${JSON.stringify(state, null, "\t")}\n`);
}

export function readManifest(dir: string): CouncilManifest {
	const value = readCouncilFile(councilPaths(dir).manifest, "manifest.json", ["slug", "tabId", "seats"]);
	// SAFETY: the council writes manifest.json itself; the version and key checks reject foreign files.
	return value as CouncilManifest;
}

export function writeManifest(dir: string, manifest: CouncilManifest): void {
	writeFileAtomic(councilPaths(dir).manifest, `${JSON.stringify(manifest, null, "\t")}\n`);
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isObject(error) && "code" in error && error.code === "EPERM";
	}
}

function tryCreateLock(path: string): boolean {
	try {
		writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if (isObject(error) && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}

type LockResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Run `run` while holding `council.lock`. A lock whose pid is no longer
 * running is taken over; a live holder is refused.
 */
export async function withCouncilLock<T>(
	dir: string,
	run: () => Promise<T>,
	pidAlive: (pid: number) => boolean = defaultPidAlive,
): Promise<LockResult<T>> {
	const path = councilPaths(dir).lock;
	mkdirSync(dir, { recursive: true });
	if (!tryCreateLock(path)) {
		let holder = Number.NaN;
		try {
			holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		} catch {
			/* a vanished lock is retried below */
		}
		if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
			return { ok: false, error: `Another council command (pid ${holder}) holds ${path}.` };
		}
		rmSync(path, { force: true });
		if (!tryCreateLock(path)) return { ok: false, error: `Could not take over the stale lock ${path}.` };
	}
	try {
		return { ok: true, value: await run() };
	} finally {
		rmSync(path, { force: true });
	}
}
