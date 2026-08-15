import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatTokens,
	type InspectorState,
	type OpenInspectorResult,
	openInspector as openSharedInspector,
	type RenderRequester,
	renderInspector as renderSharedInspector,
	InspectorComponent as SharedInspectorComponent,
	sanitizeMultilineText,
	wrapAndSanitizeText,
} from "../shared/inspector-overlay.ts";
import type { DashboardTheme } from "../shared/live-dashboard.ts";
import type { TerminalText } from "../shared/terminal-text.ts";
import type { PlanImplementDashboardStore } from "./live-dashboard.ts";
import type { PlanImplementTranscriptStore } from "./transcript-store.ts";

const COPY = {
	emptyMessage: "No plan/implement phases active",
	helpSuffix: " · ^⇧I abort",
};

export type { InspectorState, OpenInspectorResult, RenderRequester };
export { formatTokens, sanitizeMultilineText, wrapAndSanitizeText };

export function renderInspector(
	dashboard: PlanImplementDashboardStore,
	transcripts: PlanImplementTranscriptStore,
	state: InspectorState,
	width: number,
	height: number,
	theme: DashboardTheme,
	text?: TerminalText,
): string[] {
	return renderSharedInspector(dashboard, transcripts, state, width, height, theme, text, COPY);
}

export class InspectorComponent extends SharedInspectorComponent {
	constructor(
		dashboard: PlanImplementDashboardStore,
		transcripts: PlanImplementTranscriptStore,
		tui: RenderRequester,
		theme: DashboardTheme,
		onClose: () => void,
		onAbort?: () => void,
		text?: TerminalText,
	) {
		super(dashboard, transcripts, tui, theme, onClose, onAbort, text, COPY);
	}
}

export interface OpenInspectorOptions {
	text?: TerminalText;
	onAbort?: () => void;
}

export function openInspector(
	ctx: ExtensionContext,
	dashboard: PlanImplementDashboardStore,
	transcripts: PlanImplementTranscriptStore,
	options: OpenInspectorOptions = {},
): OpenInspectorResult {
	return openSharedInspector(ctx, dashboard, transcripts, { ...options, copy: COPY });
}
