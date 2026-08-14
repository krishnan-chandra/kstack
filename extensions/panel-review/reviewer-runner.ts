/** Thin panel-review adapter around the shared child-agent lifecycle. */
import { formatDuration, getPiInvocation, runChildAgent, summarizeToolCall, truncateTailUtf8, type ChildEvent, type ChildRunnerDeps, type SpawnImpl, type SpawnedProcess } from "../shared/child-agent-runner.ts";
import { LIMITS, type ReviewerResult, type ReviewerSpec } from "./types.ts";
export { formatDuration, getPiInvocation, summarizeToolCall, truncateTailUtf8 };
export type { ChildEvent, SpawnImpl, SpawnedProcess };
export interface RunnerDeps extends Omit<ChildRunnerDeps, "idleTimeoutMs"> { timeoutMs?: number; }
export function buildChildArgs(opts: { model: string; promptFile: string; task: string; noContextFiles?: boolean }): string[] {
	return ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", ...(opts.noContextFiles ? ["--no-context-files"] : []), "--tools", "read,grep,find,ls", "--model", opts.model, "--append-system-prompt", opts.promptFile, opts.task];
}
export interface RunReviewerOptions {
	spec: ReviewerSpec; model: string; promptFile: string; task: string; cwd: string; noContextFiles?: boolean; signal?: AbortSignal; deps?: RunnerDeps;
	onProgress?: (info: { label: string; turns: number; activity?: string; preview?: string }) => void;
	onEvent?: (event: ChildEvent) => void;
}
export async function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const deps = options.deps ?? {};
	const result = await runChildAgent({
		args: buildChildArgs(options), cwd: options.cwd, signal: options.signal,
		deps: { ...deps, idleTimeoutMs: deps.timeoutMs ?? LIMITS.reviewerTimeoutMs, maxRuntimeMs: deps.maxRuntimeMs ?? LIMITS.reviewerMaxRuntimeMs, outputCapBytes: deps.outputCapBytes ?? LIMITS.reviewerOutputBytes, stderrCapBytes: deps.stderrCapBytes ?? LIMITS.stderrBytes },
		onProgress: (progress) => options.onProgress?.({ label: options.spec.label, ...progress }),
		onEvent: options.onEvent,
	});
	const identity = { label: options.spec.label, model: options.model };
	if (result.status === "completed") return { ...identity, ...result };
	if (result.status === "aborted") return { ...identity, status: "aborted", usage: result.usage, activity: result.activity };
	let error = result.error;
	if (error.startsWith("Child produced no output.")) error = `Reviewer produced no output.${error.slice("Child produced no output.".length)}${result.stderr.trim() ? ` stderr: ${result.stderr.trim()}` : ""}`;
	return { ...identity, status: "failed", error, usage: result.usage, activity: result.activity };
}
