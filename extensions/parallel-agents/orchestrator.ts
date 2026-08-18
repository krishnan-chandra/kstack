import { mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import type { ParallelAgentsDashboardStore } from "./live-dashboard.ts";
import { type ParallelAgentRunnerDeps, runParallelAgent } from "./runner.ts";
import type { ParallelAgentKind, ParallelAgentResult, ParallelAgentTask } from "./types.ts";

interface ParallelAgentsRunDeps {
	runAgent?: typeof runParallelAgent;
	runnerDeps?: ParallelAgentRunnerDeps;
	dashboard?: ParallelAgentsDashboardStore;
	onTick?: () => void;
}

export async function runParallelAgents(options: {
	kind: ParallelAgentKind;
	tasks: readonly ParallelAgentTask[];
	maxConcurrency: number;
	signal?: AbortSignal;
	deps?: ParallelAgentsRunDeps;
}): Promise<ParallelAgentResult[]> {
	const deps = options.deps ?? {};
	const runAgent = deps.runAgent ?? runParallelAgent;
	let ticker: ReturnType<typeof setInterval> | undefined;
	if (deps.dashboard || deps.onTick) {
		ticker = setInterval(() => {
			deps.dashboard?.tick();
			deps.onTick?.();
		}, 1000);
		ticker.unref?.();
	}
	try {
		return await mapWithConcurrencyLimit(options.tasks, options.maxConcurrency, async (task) => {
			deps.dashboard?.markRunning(task.label);
			let result: ParallelAgentResult;
			try {
				result = await runAgent({
					owner: options.kind,
					task,
					signal: options.signal,
					deps: deps.runnerDeps,
					onProgress: (progress) => deps.dashboard?.progress(task.label, progress),
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
			deps.dashboard?.complete(task.label, {
				status: result.status,
				turns: result.usage.turns,
				...(result.status === "failed" ? { error: result.error } : {}),
			});
			return result;
		});
	} finally {
		if (ticker) clearInterval(ticker);
	}
}
