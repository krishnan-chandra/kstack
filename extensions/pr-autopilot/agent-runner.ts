/** Thin pr-autopilot adapter around the shared child-agent lifecycle. */
import {
	type ChildRunnerDeps,
	getPiInvocation,
	runChildAgent,
	type SpawnedProcess,
	type SpawnImpl,
} from "../shared/child-agent-runner.ts";
import { type AutopilotAgentRole, type AutopilotModelSpec, LIMITS, type UsageSummary } from "./types.ts";

export type { SpawnedProcess, SpawnImpl };
export { getPiInvocation };
export interface RunnerDeps extends Omit<ChildRunnerDeps, "idleTimeoutMs"> {
	timeoutMs?: number;
}
export function buildChildArgs(opts: {
	model: string;
	promptFile: string;
	taskFile: string;
	tools?: string;
}): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		...(opts.tools ? ["--tools", opts.tools] : []),
		"--model",
		opts.model,
		"--append-system-prompt",
		opts.promptFile,
		`Read the task at ${opts.taskFile}.`,
	];
}
interface AgentRunResultBase {
	role: AutopilotAgentRole;
	model: string;
	usage: UsageSummary;
}
export type AgentRunResult =
	| (AgentRunResultBase & { status: "completed"; output: string })
	| (AgentRunResultBase & { status: "failed"; error: string })
	| (AgentRunResultBase & { status: "aborted" });
export interface RunAgentOptions {
	role: AutopilotAgentRole;
	spec: AutopilotModelSpec;
	promptFile: string;
	taskFile: string;
	cwd: string;
	tools?: string;
	signal?: AbortSignal;
	deps?: RunnerDeps;
	onProgress?: (info: { role: AutopilotAgentRole; turns: number; activity?: string; preview?: string }) => void;
}
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
	const deps = options.deps ?? {};
	const model = options.spec.thinking ? `${options.spec.model}:${options.spec.thinking}` : options.spec.model;
	const result = await runChildAgent({
		args: buildChildArgs({ model, promptFile: options.promptFile, taskFile: options.taskFile, tools: options.tools }),
		cwd: options.cwd,
		signal: options.signal,
		deps: {
			...deps,
			idleTimeoutMs: deps.timeoutMs ?? LIMITS.defaultTimeoutMinutes * 60_000,
			maxRuntimeMs: deps.maxRuntimeMs ?? LIMITS.defaultMaxRuntimeMinutes * 60_000,
			outputCapBytes: deps.outputCapBytes ?? LIMITS.outputBytes,
			stderrCapBytes: deps.stderrCapBytes ?? LIMITS.stderrBytes,
			stdoutLineCapBytes: deps.stdoutLineCapBytes ?? LIMITS.stdoutLineBytes,
			killGraceMs: deps.killGraceMs ?? LIMITS.killGraceMs,
		},
		onProgress: (progress) => options.onProgress?.({ role: options.role, ...progress }),
	});
	const identity = { role: options.role, model, usage: result.usage };
	if (result.status === "completed") return { ...identity, status: "completed", output: result.output };
	if (result.status === "aborted") return { ...identity, status: "aborted" };
	return {
		...identity,
		status: "failed",
		error: result.error.startsWith("Child produced no output.")
			? `${options.role} produced no final output.`
			: result.error,
	};
}
