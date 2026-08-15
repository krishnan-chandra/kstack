import type { ChildEvent } from "../shared/child-agent-runner.ts";
import {
	type DashboardPolicy,
	type DashboardTheme,
	LiveDashboardComponent,
	LiveDashboardStore,
	mountLiveDashboard,
	type RenderRequester,
	renderDashboard as renderSharedDashboard,
	type WidgetUi,
} from "../shared/live-dashboard.ts";
import { fallbackTerminalText, type TerminalText } from "../shared/terminal-text.ts";
import type { AgentRole } from "./types.ts";

export {
	type DashboardRow,
	type DashboardStatus,
	type DashboardTheme,
	rowElapsedSeconds,
	STATUS_ICON,
} from "../shared/live-dashboard.ts";
export {
	codePointWidth,
	sanitizeDisplayText,
	stripTerminalSequencesFallback,
	type TerminalText,
} from "../shared/terminal-text.ts";

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

const PLAN_POLICY: DashboardPolicy = {
	copy: { title: "■ Plan & implement", help: " — ^⇧P inspect · ^⇧I abort" },
	modelColor: () => "dim",
	clearPreviewOnComplete: true,
};

export class PlanImplementDashboardStore extends LiveDashboardStore {
	constructor(now: () => number = () => Date.now()) {
		super(PLAN_POLICY, now);
	}

	addPhase(id: string, label: string, model: string, role: AgentRole): void {
		this.addRow(id, label, model, role, true);
	}
}

export function renderDashboard(
	store: PlanImplementDashboardStore,
	width: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
): string[] {
	return renderSharedDashboard(store, width, theme, text);
}

export class PlanImplementDashboardComponent extends LiveDashboardComponent {
	constructor(
		store: PlanImplementDashboardStore,
		tui: RenderRequester,
		theme: DashboardTheme,
		text: TerminalText = fallbackTerminalText,
	) {
		super(store, tui, theme, text);
	}
}

export function mountPlanImplementDashboard(
	ui: WidgetUi,
	store: PlanImplementDashboardStore,
	text: TerminalText = fallbackTerminalText,
): () => void {
	return mountLiveDashboard(
		ui,
		"plan-implement",
		(tui, theme) => new PlanImplementDashboardComponent(store, tui, theme, text),
	);
}
