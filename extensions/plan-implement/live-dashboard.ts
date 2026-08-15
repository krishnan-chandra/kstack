import type { ChildEvent } from "../shared/child-agent-runner.ts";
import { LiveDashboardStore } from "../shared/live-dashboard.ts";
import type { AgentRole } from "./types.ts";

export interface PlanPipelineDashboard {
	addPhase(id: string, label: string, model: string, role: AgentRole): void;
	markRunning(id: string): void;
	progress(id: string, info: { turns: number; activity?: string; preview?: string }): void;
	complete(id: string, info: { status: "completed" | "failed" | "aborted"; turns?: number; error?: string }): void;
	event(id: string, event: ChildEvent): void;
	note(id: string, text: string): void;
	tick(): void;
	dispose(): void;
}

export class PlanImplementDashboardStore extends LiveDashboardStore {
	constructor(now: () => number = () => Date.now()) {
		super("■ Plan & implement", " — ^⇧P inspect · ^⇧I abort", true, now);
	}

	addPhase(id: string, label: string, model: string, _role: AgentRole): void {
		this.addRow(id, label, model, "dim", true);
	}
}
