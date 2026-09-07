/** Testable planner → adversary debate → approval → implementer sequencing. */

import type { AgentRunResult, CritiqueFinding, CritiqueResult } from "./types.ts";

type CompletedAgentRun = Extract<AgentRunResult, { status: "completed" }>;

type WorkflowResult =
	| { status: "planner-failed"; planner: AgentRunResult }
	| { status: "debate-failed"; planner: CompletedAgentRun; critique: CritiqueResult }
	| { status: "rejected"; planner: CompletedAgentRun }
	| { status: "plan-only"; planner: CompletedAgentRun }
	| { status: "implementer-failed"; planner: CompletedAgentRun; implementer: AgentRunResult }
	| { status: "completed"; planner: CompletedAgentRun; implementer: CompletedAgentRun };

interface CritiqueOptions {
	countsAgainstBudget: boolean;
}

interface Debate {
	revisePlan: (previous: string, critique: string) => Promise<AgentRunResult>;
	critique: (plan: string, options: CritiqueOptions) => Promise<CritiqueResult>;
	maxRounds?: number;
	resolveExhaustion: (plan: string, openFindings: CritiqueFinding[]) => Promise<"verify" | "reject">;
	readPlan: () => string;
	onRound?: (round: number, result: CritiqueResult, options: CritiqueOptions) => Promise<void> | void;
}

interface WorkflowDeps {
	runPlanner: () => Promise<AgentRunResult>;
	/** Absent means skip debate; enabled debate has every required operation. */
	debate?: Debate;
	onPlan: (plan: CompletedAgentRun) => Promise<void> | void;
	approvePlan: (plan: CompletedAgentRun) => Promise<boolean>;
	planOnly?: boolean;
	runImplementer: (plan: string) => Promise<AgentRunResult>;
	onImplementation: (result: AgentRunResult) => Promise<void> | void;
}

function debateFailure(planner: CompletedAgentRun, error: string): WorkflowResult {
	return { status: "debate-failed", planner, critique: { status: "failed", error } };
}

async function runDebate(initial: CompletedAgentRun, deps: Debate): Promise<WorkflowResult | CompletedAgentRun> {
	const maxRounds = deps.maxRounds ?? 3;
	let planner = initial;
	let exhaustedCritique: Extract<CritiqueResult, { status: "completed" }> | undefined;
	let round = 0;
	while (round < maxRounds) {
		round++;
		const result = await deps.critique(planner.output, { countsAgainstBudget: true });
		await deps.onRound?.(round, result, { countsAgainstBudget: true });
		if (result.status !== "completed") return { status: "debate-failed", planner, critique: result };
		if (result.critique.verdict === "approve") return planner;
		exhaustedCritique = result;
		if (round < maxRounds) {
			const revised = await deps.revisePlan(planner.output, result.critique.raw);
			if (revised.status !== "completed") {
				return debateFailure(planner, `Planner revision did not complete (${revised.status}).`);
			}
			planner = revised;
		}
	}

	if (!exhaustedCritique) return debateFailure(planner, "Adversarial debate exhausted without a critique.");
	let open = exhaustedCritique;
	while (true) {
		const choice = await deps.resolveExhaustion(planner.output, open.critique.blocking);
		if (choice === "reject") return { status: "rejected", planner };
		planner = { ...planner, output: deps.readPlan() };
		const verified = await deps.critique(planner.output, { countsAgainstBudget: false });
		await deps.onRound?.(round + 1, verified, { countsAgainstBudget: false });
		if (verified.status !== "completed") return { status: "debate-failed", planner, critique: verified };
		if (verified.critique.verdict === "approve") return planner;
		open = verified;
	}
}

export async function runWorkflow(deps: WorkflowDeps): Promise<WorkflowResult> {
	const initialPlanner = await deps.runPlanner();
	if (initialPlanner.status !== "completed") return { status: "planner-failed", planner: initialPlanner };

	const debated = deps.debate ? await runDebate(initialPlanner, deps.debate) : initialPlanner;
	if ("planner" in debated) return debated;
	const planner = debated;

	await deps.onPlan(planner);
	if (deps.planOnly) return { status: "plan-only", planner };
	if (!(await deps.approvePlan(planner))) return { status: "rejected", planner };

	const implementer = await deps.runImplementer(planner.output);
	await deps.onImplementation(implementer);
	if (implementer.status !== "completed") return { status: "implementer-failed", planner, implementer };
	return { status: "completed", planner, implementer };
}
