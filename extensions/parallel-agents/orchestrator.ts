import type { AgentPaneRun } from "../shared/agent-pane.ts";
import { mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import { type ParallelAgentRunnerDeps, runParallelAgent } from "./runner.ts";
import type { ParallelAgentResult, ParallelAgentTask } from "./types.ts";

interface ParallelAgentsRunDeps {
	runAgent?: typeof runParallelAgent;
	runnerDeps?: ParallelAgentRunnerDeps;
	pane?: AgentPaneRun;
}

interface AgentCompletion {
	status: "completed" | "failed" | "aborted";
	turns: number;
	error?: string;
}

export async function runParallelAgents(options: {
	tasks: readonly ParallelAgentTask[];
	maxConcurrency: number;
	signal?: AbortSignal;
	deps?: ParallelAgentsRunDeps;
}): Promise<ParallelAgentResult[]> {
	const deps = options.deps ?? {};
	const runAgent = deps.runAgent ?? runParallelAgent;
	return mapWithConcurrencyLimit(options.tasks, options.maxConcurrency, async (task) => {
		if (options.signal?.aborted) {
			deps.pane?.complete(task.label, { status: "aborted", turns: 0 });
			deps.pane?.note(task.label, "Child aborted before start");
			return {
				status: "aborted",
				label: task.label,
				model: task.model,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			};
		}
		deps.pane?.markRunning(task.label);
		deps.pane?.note(task.label, "Child started");
		let result: ParallelAgentResult;
		try {
			result = await runAgent({
				task,
				signal: options.signal,
				deps: deps.runnerDeps,
				onProgress: (progress) => deps.pane?.progress(task.label, progress),
				onEvent: (event) => deps.pane?.event(task.label, event),
			});
		} catch (error) {
			result = {
				status: "failed",
				label: task.label,
				model: task.model,
				error: error instanceof Error ? error.message : String(error),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			};
		}
		const completion: AgentCompletion = {
			status: result.status,
			turns: result.usage.turns,
		};
		if (result.status === "failed") completion.error = result.error;
		deps.pane?.complete(task.label, completion);
		deps.pane?.note(task.label, `Child ${result.status}${result.status === "failed" ? `: ${result.error}` : ""}`);
		return result;
	});
}
