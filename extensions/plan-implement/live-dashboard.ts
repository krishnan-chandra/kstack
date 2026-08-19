import type { ChildEvent } from "../shared/child-agent-runner.ts";
import type { AgentRole } from "./types.ts";

export interface PlanPipelineDashboard {
	addPhase(id: string, label: string, model: string, role: AgentRole): void;
	markRunning(id: string): void;
	progress(id: string, info: { turns: number; activity?: string; preview?: string }): void;
	complete(id: string, info: { status: "completed" | "failed" | "aborted"; turns?: number; error?: string }): void;
	event(id: string, event: ChildEvent): void;
	note(id: string, text: string): void;
	dispose(): void;
}
