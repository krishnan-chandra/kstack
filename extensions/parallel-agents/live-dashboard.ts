import { LiveDashboardStore } from "../shared/live-dashboard.ts";
import type { ParallelAgentKind } from "./types.ts";

const TITLES: Record<ParallelAgentKind, string> = {
	simplify: "■ Simplify",
	arena: "■ Arena",
};

export class ParallelAgentsDashboardStore extends LiveDashboardStore {
	constructor(kind: ParallelAgentKind, now: () => number = () => Date.now()) {
		super(TITLES[kind], "", true, now);
	}

	addAgent(id: string, label: string, model: string): void {
		this.addRow(id, label, model, "dim", false);
	}
}
