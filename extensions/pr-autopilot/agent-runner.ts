/** Thin pr-autopilot adapter around the shared child-agent lifecycle. */
import {
	type ChildRunnerDeps,
	childIsolationArgs,
	runChildAgent,
	type SpawnedProcess,
	type SpawnImpl,
} from "../shared/child-agent-runner.ts";
import { type AutopilotAgentRole, type AutopilotModelSpec, LIMITS, type UsageSummary } from "./types.ts";

export type { SpawnedProcess, SpawnImpl };
export interface RunnerDeps extends Omit<ChildRunnerDeps, "idleTimeoutMs"> {
	timeoutMs?: number;
}
export function buildChildArgs(opts: {
	model: string;
	promptFile: string;
	taskFile?: string;
	tools?: string;
	noTools?: boolean;
}): string[] {
	return [
		...childIsolationArgs({ noContextFiles: true, noToolsNoApprove: opts.noTools }),
		...(opts.tools ? ["--tools", opts.tools] : []),
		"--model",
		opts.model,
		"--append-system-prompt",
		opts.promptFile,
		opts.taskFile ? `Read the task at ${opts.taskFile}.` : "Use the task supplied on standard input.",
	];
}
interface AgentRunResultBase {
	role: AutopilotAgentRole;
	model: string;
	usage: UsageSummary;
	session: import("../shared/child-agent-runner.ts").ChildSession;
}
export type AgentRunResult =
	| (AgentRunResultBase & { status: "completed"; output: string })
	| (AgentRunResultBase & { status: "failed"; error: string })
	| (AgentRunResultBase & { status: "aborted" });
export interface RunAgentOptions {
	role: AutopilotAgentRole;
	spec: AutopilotModelSpec;
	promptFile: string;
	taskFile?: string;
	cwd: string;
	tools?: string;
	noTools?: boolean;
	stdin?: string;
	signal?: AbortSignal;
	deps?: RunnerDeps;
	onProgress?: (info: { role: AutopilotAgentRole; turns: number; activity?: string; preview?: string }) => void;
}
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
	const deps = options.deps ?? {};
	const model = options.spec.thinking ? `${options.spec.model}:${options.spec.thinking}` : options.spec.model;
	const result = await runChildAgent({
		args: buildChildArgs({
			model,
			promptFile: options.promptFile,
			taskFile: options.taskFile,
			tools: options.tools,
			noTools: options.noTools,
		}),
		cwd: options.cwd,
		session: { owner: "pr-autopilot", label: options.role },
		stdin: options.stdin,
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
	const identity = { role: options.role, model, usage: result.usage, session: result.session };
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
