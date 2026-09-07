import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRunResult, CritiqueResult } from "./types.ts";
import { runWorkflow } from "./workflow.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const plan: AgentRunResult = { status: "completed", role: "planner", model: "a/p", output: "plan-1", usage };
const implementation: AgentRunResult = {
	status: "completed",
	role: "implementer",
	model: "b/i",
	output: "done",
	usage,
};

function critique(verdict: "approve" | "revise", ids: string[] = []): CritiqueResult {
	return {
		status: "completed",
		critique: {
			verdict,
			blocking: ids.map((id) => ({ id, text: `open ${id}` })),
			suggestions: [],
			resolved: [],
			raw: `Verdict: ${verdict}`,
		},
	};
}

function baseDeps() {
	return {
		runPlanner: async () => plan,
		onPlan: () => {},
		approvePlan: async () => true,
		runImplementer: async () => implementation,
		onImplementation: () => {},
	};
}

describe("runWorkflow", () => {
	it("preserves the no-adversary planner and implementer flow", async () => {
		const events: string[] = [];
		const result = await runWorkflow({
			runPlanner: async () => {
				events.push("planner");
				return plan;
			},
			onPlan: () => {
				events.push("show-plan");
			},
			approvePlan: async () => {
				events.push("approve");
				return true;
			},
			runImplementer: async (text) => {
				events.push(`implement:${text}`);
				return implementation;
			},
			onImplementation: () => {
				events.push("show-implementation");
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(events, ["planner", "show-plan", "approve", "implement:plan-1", "show-implementation"]);
	});

	it("accepts an adversary approval in round one", async () => {
		const rounds: number[] = [];
		const result = await runWorkflow({
			...baseDeps(),
			debate: {
				critique: async () => critique("approve"),
				revisePlan: async () => assert.fail("revision should not run"),
				resolveExhaustion: async () => assert.fail("exhaustion should not run"),
				readPlan: () => "unused",
				onRound: (round) => {
					rounds.push(round);
				},
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(rounds, [1]);
	});

	it("reuses planner revisions until round two approves", async () => {
		const seen: string[] = [];
		let calls = 0;
		const result = await runWorkflow({
			...baseDeps(),
			debate: {
				critique: async (text, options) => {
					seen.push(`${text}:${options.countsAgainstBudget}`);
					calls++;
					return calls === 1 ? critique("revise", ["B-1"]) : critique("approve");
				},
				revisePlan: async (previous) => ({ ...plan, output: `${previous}-revised` }),
				resolveExhaustion: async () => assert.fail("exhaustion should not run"),
				readPlan: () => "unused",
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(seen, ["plan-1:true", "plan-1-revised:true"]);
		if (result.status === "completed") assert.equal(result.planner.output, "plan-1-revised");
	});

	it("blocks on exhaustion until a human edit passes non-budgeted verification", async () => {
		const counts: boolean[] = [];
		let calls = 0;
		const result = await runWorkflow({
			...baseDeps(),
			debate: {
				maxRounds: 2,
				critique: async (_text, options) => {
					counts.push(options.countsAgainstBudget);
					calls++;
					return calls < 3 ? critique("revise", [`B-${calls}`]) : critique("approve");
				},
				revisePlan: async () => ({ ...plan, output: "plan-2" }),
				resolveExhaustion: async (_text, findings) => {
					assert.deepEqual(
						findings.map((finding) => finding.id),
						["B-2"],
					);
					return "verify";
				},
				readPlan: () => "human-edited",
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(counts, [true, true, false]);
		if (result.status === "completed") assert.equal(result.planner.output, "human-edited");
	});

	it("returns to the exhaustion gate after a failed verification", async () => {
		const choices: string[] = [];
		const edits = ["human-edit-1", "human-edit-2"];
		let calls = 0;
		const result = await runWorkflow({
			...baseDeps(),
			debate: {
				maxRounds: 1,
				critique: async () => {
					calls++;
					return calls < 3 ? critique("revise", [`B-${calls}`]) : critique("approve");
				},
				revisePlan: async () => assert.fail("budget was one round"),
				resolveExhaustion: async (text) => {
					choices.push(text);
					return "verify";
				},
				readPlan: () => edits.shift() ?? "missing",
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(choices, ["plan-1", "human-edit-1"]);
	});

	it("allows rejection at the exhaustion gate", async () => {
		const result = await runWorkflow({
			...baseDeps(),
			debate: {
				maxRounds: 1,
				critique: async () => critique("revise", ["B-1"]),
				revisePlan: async () => assert.fail("budget was one round"),
				resolveExhaustion: async () => "reject",
				readPlan: () => "unused",
			},
		});
		assert.equal(result.status, "rejected");
	});

	it("reports critique and planner-revision failures", async () => {
		const critiqueFailed = await runWorkflow({
			...baseDeps(),
			debate: {
				critique: async () => ({ status: "failed", error: "bad critique" }),
				revisePlan: async () => plan,
				resolveExhaustion: async () => "reject",
				readPlan: () => "unused",
			},
		});
		assert.equal(critiqueFailed.status, "debate-failed");

		const revisionFailed = await runWorkflow({
			...baseDeps(),
			debate: {
				critique: async () => critique("revise", ["B-1"]),
				revisePlan: async () => ({ status: "failed", role: "planner", model: "a/p", error: "bad revision" }),
				resolveExhaustion: async () => "reject",
				readPlan: () => "unused",
			},
		});
		assert.equal(revisionFailed.status, "debate-failed");
	});

	it("returns after the final plan in plan-only mode", async () => {
		let approved = false;
		let implemented = false;
		const result = await runWorkflow({
			...baseDeps(),
			planOnly: true,
			approvePlan: async () => {
				approved = true;
				return true;
			},
			runImplementer: async () => {
				implemented = true;
				return implementation;
			},
		});
		assert.equal(result.status, "plan-only");
		assert.equal(approved, false);
		assert.equal(implemented, false);
	});

	it("stops on planner failure or user rejection", async () => {
		const plannerFailed = await runWorkflow({
			...baseDeps(),
			runPlanner: async () => ({ status: "failed", role: "planner", model: "a/p", error: "bad" }),
		});
		assert.equal(plannerFailed.status, "planner-failed");
		const rejected = await runWorkflow({ ...baseDeps(), approvePlan: async () => false });
		assert.equal(rejected.status, "rejected");
	});

	it("reports implementer failure after displaying it", async () => {
		let displayed = false;
		const result = await runWorkflow({
			...baseDeps(),
			runImplementer: async () => ({ status: "aborted", role: "implementer", model: "b/i" }),
			onImplementation: () => {
				displayed = true;
			},
		});
		assert.equal(result.status, "implementer-failed");
		assert.equal(displayed, true);
	});
});
