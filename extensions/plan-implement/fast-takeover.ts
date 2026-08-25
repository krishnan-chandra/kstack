import { type BoundaryValue, isString } from "../shared/validation.ts";
/** Current-session takeover for `--fast`: pending-run tracking, commit verification, and kickoff construction. */

import { type ChangeKind, isChangeKind } from "../shared/change-kind.ts";
import { isThinkingLevel, type ModelThinkingLevel } from "../shared/kstack-config.ts";
import { isRecord } from "../shared/narrow.ts";
import type { VcsBackend, VcsResult, WorkstreamCheckpoint } from "../shared/vcs/backend.ts";
import type { VcsBackendId } from "../shared/vcs/config.ts";
import type { FastImplementOutcome } from "./fast-runner.ts";
import { LIMITS } from "./types.ts";

export const FAST_IMPLEMENT_RUN_ENTRY = "fast-implement-run";
export const FAST_IMPLEMENT_RUN_COMPLETE_ENTRY = "fast-implement-run-complete";
const MAX_KICKOFF_BYTES = 128 * 1024;

export interface FastPendingRun {
	schemaVersion: 1;
	runId: string;
	task: string;
	changeKind: ChangeKind;
	backend: VcsBackendId;
	cwd: string;
	checkpoint: WorkstreamCheckpoint;
	implementerModel?: string;
	previousModel?: string;
	previousThinking?: ModelThinkingLevel;
}

interface EntryLike {
	type?: BoundaryValue;
	customType?: BoundaryValue;
	data?: BoundaryValue;
}

function readPendingRun(value: BoundaryValue): FastPendingRun | undefined {
	if (!isRecord(value) || !isRecord(value.checkpoint)) return undefined;
	if (
		value.schemaVersion !== 1 ||
		!isString(value.runId) ||
		value.runId.length === 0 ||
		value.runId.length > 128 ||
		!isString(value.task) ||
		Buffer.byteLength(value.task, "utf8") > LIMITS.taskBytes ||
		!isString(value.changeKind) ||
		!isChangeKind(value.changeKind) ||
		(value.backend !== "git" && value.backend !== "jj" && value.backend !== "graphite") ||
		!isString(value.cwd) ||
		value.cwd.length === 0 ||
		!isString(value.checkpoint.ref) ||
		value.checkpoint.ref.length === 0 ||
		!isString(value.checkpoint.baseSha) ||
		value.checkpoint.baseSha.length === 0 ||
		(value.implementerModel !== undefined &&
			(!isString(value.implementerModel) || value.implementerModel.length === 0)) ||
		(value.previousModel !== undefined && (!isString(value.previousModel) || value.previousModel.length === 0)) ||
		(value.previousThinking !== undefined && !isThinkingLevel(value.previousThinking))
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		runId: value.runId,
		task: value.task,
		changeKind: value.changeKind,
		backend: value.backend,
		cwd: value.cwd,
		checkpoint: { ref: value.checkpoint.ref, baseSha: value.checkpoint.baseSha },
		...(isString(value.implementerModel) ? { implementerModel: value.implementerModel } : undefined),
		...(isString(value.previousModel) ? { previousModel: value.previousModel } : undefined),
		...(isThinkingLevel(value.previousThinking) ? { previousThinking: value.previousThinking } : undefined),
	};
}

/** Return the newest unresolved run stored on the active session branch. */
export function findPendingFastRun(entries: readonly EntryLike[]): FastPendingRun | undefined {
	const completed = new Set<string>();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom") continue;
		if (entry.customType === FAST_IMPLEMENT_RUN_COMPLETE_ENTRY && isRecord(entry.data)) {
			if (isString(entry.data.runId)) completed.add(entry.data.runId);
			continue;
		}
		if (entry.customType !== FAST_IMPLEMENT_RUN_ENTRY) continue;
		const run = readPendingRun(entry.data);
		if (run && !completed.has(run.runId)) return run;
	}
	return undefined;
}

/** Gates the settle handler so a run is verified at most once per settle. */
export class FastTakeoverController {
	private verifyingRunId: string | undefined;

	reset(): void {
		this.verifyingRunId = undefined;
	}

	begin(entries: readonly EntryLike[]): FastPendingRun | undefined {
		const pending = findPendingFastRun(entries);
		if (!pending || this.verifyingRunId === pending.runId) return undefined;
		this.verifyingRunId = pending.runId;
		return pending;
	}

	finish(runId: string): void {
		if (this.verifyingRunId === runId) this.verifyingRunId = undefined;
	}
}

export async function preflightFastWorkstream(
	backend: Pick<VcsBackend, "preflight">,
	cwd: string,
): Promise<VcsResult<{ workspaceRoot: string }>> {
	try {
		return await backend.preflight(cwd);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function createFastWorkstream(
	backend: Pick<VcsBackend, "createWorkstream">,
	cwd: string,
	task: string,
): Promise<VcsResult<WorkstreamCheckpoint>> {
	try {
		return await backend.createWorkstream(cwd, task);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function verifyFastRun(
	run: FastPendingRun,
	backend: Pick<VcsBackend, "verifyRecordedWorkstream">,
): Promise<FastImplementOutcome> {
	const verified = await backend.verifyRecordedWorkstream(run.cwd, {
		...run.checkpoint,
		requireNewCommit: true,
	});
	if (!verified.ok) {
		return {
			status: "failed",
			error: verified.error,
			branch: run.checkpoint.ref,
			cwd: run.cwd,
		};
	}
	return {
		status: "completed",
		branch: run.checkpoint.ref,
		cwd: run.cwd,
		output: "The fast implementation session settled with a verified local commit.",
	};
}

type FastSettlement =
	| { kind: "complete"; outcome: Extract<FastImplementOutcome, { status: "completed" }> }
	| { kind: "pending"; reason: string };

/** A failed settle is provisional: later user turns may still commit the run. */
export async function checkFastSettlement(
	run: FastPendingRun,
	backend: Pick<VcsBackend, "verifyRecordedWorkstream">,
): Promise<FastSettlement> {
	try {
		const outcome = await verifyFastRun(run, backend);
		return outcome.status === "completed" ? { kind: "complete", outcome } : { kind: "pending", reason: outcome.error };
	} catch (error) {
		return { kind: "pending", reason: error instanceof Error ? error.message : String(error) };
	}
}

export function buildFastKickoff(run: FastPendingRun, guidance: string): string {
	const prompt = `${guidance}\n\n---\n\n# Fast implementation task\n\n${run.task}\n\nVCS backend: ${run.backend}\nWorkstream: ${run.checkpoint.ref}\nStarting revision: ${run.checkpoint.baseSha}\n\nUse the plan and prior discussion already in this session as context. Then inspect the repository, implement this task, run focused verification, and commit coherent changes locally. Do not push, publish, open a PR, or land. When your work is committed and verified, finish the turn; the extension will verify the workstream automatically.`;
	if (Buffer.byteLength(prompt, "utf8") > MAX_KICKOFF_BYTES) {
		throw new Error(`Fast implementation kickoff exceeds ${MAX_KICKOFF_BYTES} bytes.`);
	}
	return prompt;
}
