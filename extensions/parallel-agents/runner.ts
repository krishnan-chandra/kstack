import {
	type ChildEvent,
	type ChildRunnerDeps,
	childIsolationArgs,
	runChildAgent,
} from "../shared/child-agent-runner.ts";
import type { ParallelAgentResult, ParallelAgentTask } from "./types.ts";

export interface ParallelAgentRunnerDeps extends ChildRunnerDeps {
	idleTimeoutMs?: number;
	maxRuntimeMs?: number;
}

export function buildParallelAgentArgs(task: ParallelAgentTask): string[] {
	return [
		...childIsolationArgs({ noContextFiles: true }),
		"--tools",
		task.access === "read-only" ? "read,grep,find,ls" : "read,grep,find,ls,write,edit,bash",
		"--model",
		task.model,
	];
}

export async function runParallelAgent(options: {
	owner: "simplify" | "arena";
	task: ParallelAgentTask;
	signal?: AbortSignal;
	deps?: ParallelAgentRunnerDeps;
	onProgress?: (info: { turns: number; activity?: string; preview?: string }) => void;
	onEvent?: (event: ChildEvent) => void;
}): Promise<ParallelAgentResult> {
	const deps = options.deps ?? {};
	const result = await runChildAgent({
		args: buildParallelAgentArgs(options.task),
		cwd: options.task.cwd,
		session: { owner: options.owner, label: options.task.label },
		stdin: options.task.prompt,
		signal: options.signal,
		deps: {
			...deps,
			idleTimeoutMs: deps.idleTimeoutMs ?? 10 * 60_000,
			maxRuntimeMs: deps.maxRuntimeMs ?? 30 * 60_000,
			outputCapBytes: deps.outputCapBytes ?? 256 * 1024,
			stderrCapBytes: deps.stderrCapBytes ?? 64 * 1024,
		},
		onProgress: options.onProgress,
		onEvent: options.onEvent,
	});
	return { label: options.task.label, model: options.task.model, ...result };
}
