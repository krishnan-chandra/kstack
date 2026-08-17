import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChangeKind, isChangeKind } from "../shared/change-kind.ts";
import { isRecord } from "../shared/narrow.ts";
import type { VcsBackend, VcsResult, WorkstreamCheckpoint } from "../shared/vcs/backend.ts";
import type { VcsBackendId } from "../shared/vcs/config.ts";
import { type FastImplementOutcome, LIMITS } from "./types.ts";

export const FAST_IMPLEMENT_RUN_ENTRY = "fast-implement-run";
export const FAST_IMPLEMENT_RUN_COMPLETE_ENTRY = "fast-implement-run-complete";
type PreviousThinking = NonNullable<ExtensionContext["thinkingLevel"]>;
const MAX_KICKOFF_BYTES = 128 * 1024;

export interface PendingFastImplementRun {
	schemaVersion: 1;
	runId: string;
	task: string;
	changeKind: ChangeKind;
	backend: VcsBackendId;
	cwd: string;
	checkpoint: WorkstreamCheckpoint;
	implementerModel?: string;
	previousModel?: string;
	previousThinking?: PreviousThinking;
}

interface EntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function isPreviousThinking(value: unknown): value is PreviousThinking {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function readPendingRun(value: unknown): PendingFastImplementRun | undefined {
	if (!isRecord(value) || !isRecord(value.checkpoint)) return undefined;
	if (
		value.schemaVersion !== 1 ||
		typeof value.runId !== "string" ||
		value.runId.length === 0 ||
		value.runId.length > 128 ||
		typeof value.task !== "string" ||
		Buffer.byteLength(value.task, "utf8") > LIMITS.maxTaskBytes ||
		typeof value.changeKind !== "string" ||
		!isChangeKind(value.changeKind) ||
		(value.backend !== "git" && value.backend !== "jj") ||
		typeof value.cwd !== "string" ||
		value.cwd.length === 0 ||
		typeof value.checkpoint.ref !== "string" ||
		value.checkpoint.ref.length === 0 ||
		typeof value.checkpoint.baseSha !== "string" ||
		value.checkpoint.baseSha.length === 0 ||
		(value.implementerModel !== undefined &&
			(typeof value.implementerModel !== "string" || value.implementerModel.length === 0)) ||
		(value.previousModel !== undefined &&
			(typeof value.previousModel !== "string" || value.previousModel.length === 0)) ||
		(value.previousThinking !== undefined && !isPreviousThinking(value.previousThinking))
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
		...(typeof value.implementerModel === "string" ? { implementerModel: value.implementerModel } : {}),
		...(typeof value.previousModel === "string" ? { previousModel: value.previousModel } : {}),
		...(isPreviousThinking(value.previousThinking) ? { previousThinking: value.previousThinking } : {}),
	};
}

/** Return the newest unresolved run stored on the active session branch. */
export function findPendingFastImplementRun(entries: readonly EntryLike[]): PendingFastImplementRun | undefined {
	const completed = new Set<string>();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom") continue;
		if (entry.customType === FAST_IMPLEMENT_RUN_COMPLETE_ENTRY && isRecord(entry.data)) {
			if (typeof entry.data.runId === "string") completed.add(entry.data.runId);
			continue;
		}
		if (entry.customType !== FAST_IMPLEMENT_RUN_ENTRY) continue;
		const run = readPendingRun(entry.data);
		if (run && !completed.has(run.runId)) return run;
	}
	return undefined;
}

export class TakeoverSettlementController {
	private verifyingRunId: string | undefined;

	reset(): void {
		this.verifyingRunId = undefined;
	}

	begin(entries: readonly EntryLike[]): PendingFastImplementRun | undefined {
		const pending = findPendingFastImplementRun(entries);
		if (!pending || this.verifyingRunId === pending.runId) return undefined;
		this.verifyingRunId = pending.runId;
		return pending;
	}

	finish(runId: string): void {
		if (this.verifyingRunId === runId) this.verifyingRunId = undefined;
	}
}

export async function preflightTakeoverWorkstream(
	backend: Pick<VcsBackend, "preflight">,
	cwd: string,
): Promise<VcsResult<{ workspaceRoot: string }>> {
	try {
		return await backend.preflight(cwd);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function createTakeoverWorkstream(
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

export async function verifyTakeoverRun(
	run: PendingFastImplementRun,
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

type TakeoverSettlement =
	| { kind: "complete"; outcome: Extract<FastImplementOutcome, { status: "completed" }> }
	| { kind: "pending"; reason: string };

/** A failed settle is provisional: later user turns may still commit the run. */
export async function checkTakeoverSettlement(
	run: PendingFastImplementRun,
	backend: Pick<VcsBackend, "verifyRecordedWorkstream">,
): Promise<TakeoverSettlement> {
	try {
		const outcome = await verifyTakeoverRun(run, backend);
		return outcome.status === "completed" ? { kind: "complete", outcome } : { kind: "pending", reason: outcome.error };
	} catch (error) {
		return { kind: "pending", reason: error instanceof Error ? error.message : String(error) };
	}
}

export function buildTakeoverKickoff(run: PendingFastImplementRun, guidance: string): string {
	const prompt = `${guidance}\n\n---\n\n# Fast implementation task\n\n${run.task}\n\nVCS backend: ${run.backend}\nWorkstream: ${run.checkpoint.ref}\nStarting revision: ${run.checkpoint.baseSha}\n\nUse the plan and prior discussion already in this session as context. Then inspect the repository, implement this task, run focused verification, and commit coherent changes locally. Do not push, publish, open a PR, or land. When your work is committed and verified, finish the turn; the extension will verify the workstream automatically.`;
	if (Buffer.byteLength(prompt, "utf8") > MAX_KICKOFF_BYTES) {
		throw new Error(`Fast implementation kickoff exceeds ${MAX_KICKOFF_BYTES} bytes.`);
	}
	return prompt;
}
