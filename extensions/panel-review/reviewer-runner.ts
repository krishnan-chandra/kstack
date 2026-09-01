/** Thin panel-review adapter around the shared child-agent lifecycle. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ChildEvent,
	type ChildRunnerDeps,
	childIsolationArgs,
	runChildAgent,
	type SpawnedProcess,
	type SpawnImpl,
} from "../shared/child-agent-runner.ts";
import { LIMITS, type ReviewerResult, type ReviewerSpec } from "./types.ts";

export type { ChildEvent, SpawnedProcess, SpawnImpl };

const SESSION_ARCHIVE_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "../session-archive/index.ts");
const REVIEW_TOOLS = "bash,read,grep,find,ls,search_session_archive,read_session_archive";

export interface RunnerDeps extends Omit<ChildRunnerDeps, "idleTimeoutMs"> {
	timeoutMs?: number;
}
export function buildChildArgs(opts: {
	model: string;
	promptFile: string;
	task: string;
	noContextFiles?: boolean;
}): string[] {
	return [
		...childIsolationArgs({ noContextFiles: opts.noContextFiles ?? false }),
		"--extension",
		SESSION_ARCHIVE_EXTENSION,
		"--tools",
		REVIEW_TOOLS,
		"--model",
		opts.model,
		"--append-system-prompt",
		opts.promptFile,
		opts.task,
	];
}
interface RunReviewerOptions {
	spec: ReviewerSpec;
	model: string;
	promptFile: string;
	task: string;
	cwd: string;
	noContextFiles?: boolean;
	signal?: AbortSignal;
	deps?: RunnerDeps;
	onProgress?: (info: { label: string; turns: number; activity?: string; preview?: string }) => void;
	onEvent?: (event: ChildEvent) => void;
}
export async function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const deps = options.deps ?? {};
	const result = await runChildAgent({
		args: buildChildArgs(options),
		cwd: options.cwd,
		session: { owner: "panel-review", label: options.spec.label },
		signal: options.signal,
		deps: {
			...deps,
			idleTimeoutMs: deps.timeoutMs ?? LIMITS.reviewerTimeoutMs,
			maxRuntimeMs: deps.maxRuntimeMs ?? LIMITS.reviewerMaxRuntimeMs,
			outputCapBytes: deps.outputCapBytes ?? LIMITS.reviewerOutputBytes,
			stderrCapBytes: deps.stderrCapBytes ?? LIMITS.stderrBytes,
		},
		onProgress: (progress) => options.onProgress?.({ label: options.spec.label, ...progress }),
		onEvent: options.onEvent,
	});
	const identity = { label: options.spec.label, model: options.model };
	if (result.status === "completed") return { ...identity, ...result };
	if (result.status === "aborted")
		return { ...identity, status: "aborted", usage: result.usage, activity: result.activity, session: result.session };
	let error = result.error;
	if (error.startsWith("Child produced no output."))
		error = `Reviewer produced no output.${error.slice("Child produced no output.".length)}${result.stderr.trim() ? ` stderr: ${result.stderr.trim()}` : ""}`;
	return {
		...identity,
		status: "failed",
		error,
		usage: result.usage,
		activity: result.activity,
		session: result.session,
	};
}
