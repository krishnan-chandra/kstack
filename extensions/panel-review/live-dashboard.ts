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

const PANEL_POLICY: DashboardPolicy = {
	copy: { title: "■ Panel review", help: " — ^⇧V inspect · ^⇧X abort" },
	modelColor: (row) => (row.kind === "lead" ? "accent" : "dim"),
	clearPreviewOnComplete: false,
};

export class PanelDashboardStore extends LiveDashboardStore {
	constructor(now: () => number = () => Date.now()) {
		super(PANEL_POLICY, now);
	}

	addReviewer(id: string, label: string, model: string): void {
		this.addRow(id, label, model, "reviewer", false);
	}

	addLead(id: string, label: string, model: string): void {
		this.addRow(id, label, model, "lead", true);
	}
}

export function renderDashboard(
	store: PanelDashboardStore,
	width: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
): string[] {
	return renderSharedDashboard(store, width, theme, text);
}

export class PanelDashboardComponent extends LiveDashboardComponent {
	constructor(
		store: PanelDashboardStore,
		tui: RenderRequester,
		theme: DashboardTheme,
		text: TerminalText = fallbackTerminalText,
	) {
		super(store, tui, theme, text);
	}
}

export function mountPanelDashboard(
	ui: WidgetUi,
	store: PanelDashboardStore,
	text: TerminalText = fallbackTerminalText,
): () => void {
	return mountLiveDashboard(ui, "panel-review", (tui, theme) => new PanelDashboardComponent(store, tui, theme, text));
}
