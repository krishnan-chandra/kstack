import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChildUsage } from "../shared/child-agent-runner.ts";
import { ParallelAgentsDashboardStore } from "./live-dashboard.ts";
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

	it("feeds child progress and terminal state into the shared dashboard", async () => {
		const dashboard = new ParallelAgentsDashboardStore("arena", () => 1000);
		dashboard.addAgent("a", "a", "model/a");
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
				dashboard,
				runAgent: async ({ onProgress }) => {
					onProgress?.({ turns: 2, activity: "grep x", preview: "draft" });
					return completed;
				},
			},
		});
		const row = dashboard.getRows()[0];
		assert.equal(row.status, "completed");
		assert.equal(row.turns, 4);
		assert.equal(row.preview, undefined);
	});
});
