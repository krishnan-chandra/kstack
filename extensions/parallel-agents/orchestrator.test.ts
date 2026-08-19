import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentPaneRun } from "../shared/agent-pane.ts";
import type { ChildUsage } from "../shared/child-agent-runner.ts";
import { runParallelAgents } from "./orchestrator.ts";
import type { ParallelAgentResult, ParallelAgentTask } from "./types.ts";

const usage: ChildUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const session = { kind: "missing", reason: "not-reported" } as const;
const tasks: ParallelAgentTask[] = ["a", "b", "c"].map((label) => ({
	label,
	model: `model/${label}`,
	prompt: label,
	access: "read-only",
	cwd: "/repo",
}));

describe("runParallelAgents", () => {
	it("caps concurrency, preserves input order, and keeps partial failures", async () => {
		let running = 0;
		let peak = 0;
		const result = await runParallelAgents({
			kind: "simplify",
			tasks,
			maxConcurrency: 2,
			deps: {
				runAgent: async ({ task, onProgress }) => {
					running++;
					peak = Math.max(peak, running);
					onProgress?.({ turns: 1, activity: `read ${task.label}` });
					await new Promise((resolve) => setTimeout(resolve, task.label === "a" ? 20 : 5));
					running--;
					if (task.label === "b") throw new Error("boom");
					return { status: "completed", label: task.label, model: task.model, output: task.label, usage, session };
				},
			},
		});
		assert.equal(peak, 2);
		assert.deepEqual(
			result.map((item) => item.label),
			["a", "b", "c"],
		);
		assert.deepEqual(
			result.map((item) => item.status),
			["completed", "failed", "completed"],
		);
	});

	it("feeds child events, progress, and terminal state into the pane", async () => {
		const calls: string[] = [];
		const pane: AgentPaneRun = {
			addChild() {},
			markRunning: (id) => calls.push(`running:${id}`),
			progress: (id, info) => calls.push(`progress:${id}:${info.turns}`),
			complete: (id, info) => calls.push(`complete:${id}:${info.status}:${info.turns}`),
			event: (id, event) => calls.push(`event:${id}:${event.kind}`),
			note: (id, text) => calls.push(`note:${id}:${text}`),
			dispose() {},
		};
		const completed: ParallelAgentResult = {
			status: "completed",
			label: "a",
			model: "model/a",
			output: "done",
			usage: { ...usage, turns: 4 },
			session,
		};
		await runParallelAgents({
			kind: "arena",
			tasks: [tasks[0]],
			maxConcurrency: 1,
			deps: {
				pane,
				runAgent: async ({ onProgress, onEvent }) => {
					onProgress?.({ turns: 2, activity: "grep x", preview: "draft" });
					onEvent?.({ kind: "tool_start", summary: "grep x", at: 1 });
					return completed;
				},
			},
		});
		assert.deepEqual(calls, [
			"running:a",
			"note:a:Child started",
			"progress:a:2",
			"event:a:tool_start",
			"complete:a:completed:4",
			"note:a:Child completed",
		]);
	});
});
