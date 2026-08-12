import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRunResult } from "./types.ts";
import { runWorkflow } from "./workflow.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const plan: AgentRunResult = { status: "completed", role: "planner", model: "a/p", output: "the plan", usage };
const implementation: AgentRunResult = { status: "completed", role: "implementer", model: "b/i", output: "done", usage };

describe("runWorkflow", () => {
	it("passes the exact approved plan to the implementer in order", async () => {
		const events: string[] = [];
		const result = await runWorkflow({
			runPlanner: async () => (events.push("planner"), plan),
			onPlan: async () => void events.push("show-plan"),
			approvePlan: async () => (events.push("approve"), true),
			runImplementer: async (text) => (events.push(`implement:${text}`), implementation),
			onImplementation: async () => void events.push("show-implementation"),
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(events, ["planner", "show-plan", "approve", "implement:the plan", "show-implementation"]);
	});

	it("stops on planner failure", async () => {
		let later = false;
		const result = await runWorkflow({
			runPlanner: async () => ({ status: "failed", role: "planner", model: "a/p", error: "bad" }),
			onPlan: () => { later = true; },
			approvePlan: async () => (later = true),
			runImplementer: async () => (later = true, implementation),
			onImplementation: () => { later = true; },
		});
		assert.equal(result.status, "planner-failed");
		assert.equal(later, false);
	});

	it("rejection prevents implementation", async () => {
		let implemented = false;
		const result = await runWorkflow({
			runPlanner: async () => plan,
			onPlan: () => {},
			approvePlan: async () => false,
			runImplementer: async () => (implemented = true, implementation),
			onImplementation: () => {},
		});
		assert.equal(result.status, "rejected");
		assert.equal(implemented, false);
	});

	it("reports implementer failure after displaying it", async () => {
		let displayed = false;
		const result = await runWorkflow({
			runPlanner: async () => plan,
			onPlan: () => {},
			approvePlan: async () => true,
			runImplementer: async () => ({ status: "aborted", role: "implementer", model: "b/i" }),
			onImplementation: () => { displayed = true; },
		});
		assert.equal(result.status, "implementer-failed");
		assert.equal(displayed, true);
	});
});
