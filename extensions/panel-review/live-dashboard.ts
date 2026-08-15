import { LiveDashboardStore } from "../shared/live-dashboard.ts";

export class PanelDashboardStore extends LiveDashboardStore {
	constructor(now: () => number = () => Date.now()) {
		super("■ Panel review", " — ^⇧V inspect · ^⇧X abort", false, now);
	}

	addReviewer(id: string, label: string, model: string): void {
		this.addRow(id, label, model, "dim", false);
	}

	addLead(id: string, label: string, model: string): void {
		this.addRow(id, label, model, "accent", true);
	}
}
