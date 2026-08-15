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
import type { DashboardTheme, PanelDashboardStore, TerminalText } from "./live-dashboard.ts";
import type { PanelTranscriptStore } from "./transcript-store.ts";

export type { InspectorState, OpenInspectorResult, RenderRequester };
export { formatTokens, sanitizeMultilineText, wrapAndSanitizeText };

export function renderInspector(
	dashboard: PanelDashboardStore,
	transcripts: PanelTranscriptStore,
	state: InspectorState,
	width: number,
	height: number,
	theme: DashboardTheme,
	text?: TerminalText,
): string[] {
	return renderSharedInspector(dashboard, transcripts, state, width, height, theme, text);
}

export class InspectorComponent extends SharedInspectorComponent {}

export interface OpenInspectorOptions {
	text?: TerminalText;
	onAbort?: () => void;
}

export function openInspector(
	ctx: ExtensionContext,
	dashboard: PanelDashboardStore,
	transcripts: PanelTranscriptStore,
	options: OpenInspectorOptions = {},
): OpenInspectorResult {
	return openSharedInspector(ctx, dashboard, transcripts, options);
}
