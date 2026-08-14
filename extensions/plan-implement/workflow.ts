/** Testable planner → approval → implementer sequencing. */

import type { AgentRunResult } from "./types.ts";

type WorkflowResult =
	| { status: "planner-failed"; planner: AgentRunResult }
	| { status: "rejected"; planner: Extract<AgentRunResult, { status: "completed" }> }
	| {
			status: "implementer-failed";
			planner: Extract<AgentRunResult, { status: "completed" }>;
			implementer: AgentRunResult;
	  }
	| {
			status: "completed";
			planner: Extract<AgentRunResult, { status: "completed" }>;
			implementer: Extract<AgentRunResult, { status: "completed" }>;
	  };

interface WorkflowDeps {
	runPlanner: () => Promise<AgentRunResult>;
	onPlan: (plan: Extract<AgentRunResult, { status: "completed" }>) => Promise<void> | void;
	approvePlan: (plan: Extract<AgentRunResult, { status: "completed" }>) => Promise<boolean>;
	runImplementer: (plan: string) => Promise<AgentRunResult>;
	onImplementation: (result: AgentRunResult) => Promise<void> | void;
}

export async function runWorkflow(deps: WorkflowDeps): Promise<WorkflowResult> {
	const planner = await deps.runPlanner();
	if (planner.status !== "completed") return { status: "planner-failed", planner };

	await deps.onPlan(planner);
	if (!(await deps.approvePlan(planner))) return { status: "rejected", planner };

	const implementer = await deps.runImplementer(planner.output);
	await deps.onImplementation(implementer);
	if (implementer.status !== "completed") {
		return { status: "implementer-failed", planner, implementer };
	}
	return { status: "completed", planner, implementer };
}
