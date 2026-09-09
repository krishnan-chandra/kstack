import type { ChildSession, ChildUsage } from "../shared/child-agent-runner.ts";

export interface ParallelAgentTask {
	label: string;
	model: string;
	prompt: string;
	cwd: string;
}

export type ParallelAgentResult =
	| {
			status: "completed";
			label: string;
			model: string;
			output: string;
			usage: ChildUsage;
			session?: ChildSession;
	  }
	| {
			status: "failed";
			label: string;
			model: string;
			error: string;
			usage: ChildUsage;
			activity?: string;
			session?: ChildSession;
	  }
	| {
			status: "aborted";
			label: string;
			model: string;
			usage: ChildUsage;
			activity?: string;
			session?: ChildSession;
	  };

export interface ParallelAgentsDetails {
	results: ParallelAgentResult[];
}
