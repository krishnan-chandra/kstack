import type { ChildSession, ChildUsage } from "../shared/child-agent-runner.ts";

export type ParallelAgentKind = "simplify" | "arena";

export interface ParallelAgentTask {
	label: string;
	model: string;
	prompt: string;
	access: "read-only" | "workspace";
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
	kind: ParallelAgentKind;
	results: ParallelAgentResult[];
}
