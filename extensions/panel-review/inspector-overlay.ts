/**
 * Read-only transcript inspector overlay for panel-review.
 *
 * Provides a focusable, strictly read-only popup overlay allowing the user
 * to inspect the streaming and historical transcripts of each panel child
 * (reviewers + lead synthesis).
 *
 * All displayed text is treated as untrusted: ANSI/OSC/APC sequences and
 * control characters (except newlines) are stripped, and every line is
 * truncated to the display width.
 *
 * Ephemeral only — nothing here is written to the session or disk.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component } from "@earendil-works/pi-tui";
import {
	formatDuration,
	type ChildUsage,
} from "../shared/child-agent-runner.ts";
import {
	PanelDashboardStore,
	rowElapsedSeconds,
	sanitizeDisplayText,
	STATUS_ICON,
	stripTerminalSequencesFallback,
	type DashboardRow,
	type DashboardStatus,
	type DashboardTheme,
	type TerminalText,
} from "./live-dashboard.ts";
import {
	EVICTION_NOTICE,
	PanelTranscriptStore,
	type TranscriptEntry,
} from "./transcript-store.ts";

export interface InspectorState {
	selectedIndex: number;
	scrollOffset: number; // lines from bottom; 0 = follow tail
	follow: boolean;
}

const fallbackTerminalText: TerminalText = {
	stripTerminalSequences: stripTerminalSequencesFallback,
	truncateToWidth: (t, w) => (t.length > w ? `${t.slice(0, Math.max(0, w - 1))}…` : t),
};

export { STATUS_ICON };

/**
 * Sanitize untrusted child text preserving newlines for multiline display.
 * Strips ANSI/OSC/APC and C0/C1 control characters except newline.
 */
export function sanitizeMultilineText(input: string, text: TerminalText = fallbackTerminalText): string {
	const stripped = text.stripTerminalSequences(input);
	return stripped
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]+/g, " ");
}

/** Format token counts compactly (e.g. 12.4k or 800). */
export function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	const k = count / 1000;
	return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
}

/** Break raw text into wrapped lines that fit within width. */
export function wrapAndSanitizeText(
	rawText: string,
	width: number,
	text: TerminalText = fallbackTerminalText,
): string[] {
	if (width <= 0) return [];
	const safe = sanitizeMultilineText(rawText, text);
	const rawLines = safe.split("\n");
	const result: string[] = [];

	for (const line of rawLines) {
		if (line.length === 0) {
			result.push("");
			continue;
		}
		let current = line;
		while (current.length > 0) {
			if (current.length <= width) {
				result.push(current);
				break;
			}
			let breakIdx = current.lastIndexOf(" ", width);
			if (breakIdx <= 0) {
				breakIdx = width;
			}
			result.push(current.slice(0, breakIdx));
			current = current.slice(breakIdx).trimStart();
		}
	}
	return result;
}

/** Compute flattened formatted lines for the selected child. */
export function computeInspectorBodyLines(
	dashboard: PanelDashboardStore,
	transcripts: PanelTranscriptStore,
	selectedIndex: number,
	width: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
): string[] {
	const rows = dashboard.getRows();
	if (rows.length === 0) {
		return [theme.fg("dim", "(no transcript yet)")];
	}
	const clampedIndex = Math.max(0, Math.min(selectedIndex, rows.length - 1));
	const selectedId = rows[clampedIndex].id;

	const allBodyLines: string[] = [];
	if (transcripts.wasEvicted(selectedId)) {
		allBodyLines.push(theme.fg("warning", EVICTION_NOTICE));
	}

	const entries = transcripts.getEntries(selectedId);
	for (const entry of entries) {
		switch (entry.kind) {
			case "note": {
				const safe = sanitizeDisplayText(entry.text, text);
				allBodyLines.push(theme.fg("dim", `— ${safe}`));
				break;
			}
			case "tool": {
				let line = `${theme.fg("accent", "●")} ${theme.fg("muted", sanitizeDisplayText(entry.summary, text))}`;
				if (entry.durationMs !== undefined) {
					line += ` ${theme.fg("dim", `· ${formatDuration(entry.durationMs)}`)}`;
				}
				allBodyLines.push(line);
				break;
			}
			case "turn": {
				const u = entry.usage;
				let turnLine = `— turn ${entry.turn} · in ${formatTokens(u.input)} out ${formatTokens(u.output)}`;
				if (u.cost > 0) {
					turnLine += ` · $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(3)}`;
				}
				allBodyLines.push(theme.fg("dim", turnLine));
				break;
			}
			case "text": {
				const wrapped = wrapAndSanitizeText(entry.text, Math.max(10, width - 2), text);
				for (const w of wrapped) {
					allBodyLines.push(w);
				}
				break;
			}
		}
	}

	const liveTail = transcripts.getLiveTail(selectedId);
	if (liveTail) {
		const wrappedTail = wrapAndSanitizeText(liveTail, Math.max(10, width - 2), text);
		for (const w of wrappedTail) {
			allBodyLines.push(theme.fg("dim", w));
		}
	}

	if (allBodyLines.length === 0) {
		allBodyLines.push(theme.fg("dim", "(no transcript yet)"));
	}

	return allBodyLines;
}

/**
 * Pure renderer: produces width-safe, themed inspector overlay lines.
 */
export function renderInspector(
	dashboard: PanelDashboardStore,
	transcripts: PanelTranscriptStore,
	state: InspectorState,
	width: number,
	height: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
): string[] {
	const rows = dashboard.getRows();
	if (rows.length === 0) {
		return [text.truncateToWidth(theme.fg("muted", "No panel children active"), width)];
	}

	const clampedIndex = Math.max(0, Math.min(state.selectedIndex, rows.length - 1));
	const selectedRow = rows[clampedIndex];
	const selectedId = selectedRow.id;

	// Line 1: Tab bar
	const tabs = rows.map((row, index) => {
		const isSelected = index === clampedIndex;
		const { icon, color } = STATUS_ICON[row.status];
		const safeLabel = sanitizeDisplayText(row.label, text);
		const iconStr = theme.fg(color, icon);
		if (isSelected) {
			return `${iconStr} ${theme.fg("accent", safeLabel)}`;
		}
		return `${iconStr} ${theme.fg("muted", safeLabel)}`;
	});
	const tabLine = tabs.join("   ");

	// Line 2: Meta line
	const safeModel = sanitizeDisplayText(selectedRow.model, text);
	const elapsed = rowElapsedSeconds(selectedRow, dashboard.nowMs());
	const metaParts: string[] = [
		safeModel,
		selectedRow.status,
		`${selectedRow.turns}t`,
	];
	if (elapsed !== undefined) metaParts.push(`${elapsed}s`);

	let totalCost = 0;
	for (const entry of transcripts.getEntries(selectedId)) {
		if (entry.kind === "turn") totalCost += entry.usage.cost;
	}
	if (totalCost > 0) {
		metaParts.push(`$${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(3)}`);
	}
	const metaLine = theme.fg("dim", `— ${metaParts.join(" · ")} —`);

	// Body lines
	const allBodyLines = computeInspectorBodyLines(
		dashboard,
		transcripts,
		clampedIndex,
		width,
		theme,
		text,
	);

	// Last line: Key help
	const helpText = `←→/tab child · ↑↓ PgUp PgDn scroll · f follow [${state.follow ? "ON" : "OFF"}] · esc close`;
	const helpLine = theme.fg("dim", helpText);

	// Windowing
	const availableBodyHeight = Math.max(1, height - 3);
	let visibleBodyLines: string[];

	if (state.follow) {
		visibleBodyLines = allBodyLines.slice(Math.max(0, allBodyLines.length - availableBodyHeight));
	} else {
		const maxScroll = Math.max(0, allBodyLines.length - availableBodyHeight);
		const clampedScroll = Math.max(0, Math.min(state.scrollOffset, maxScroll));
		const startIdx = Math.max(0, allBodyLines.length - availableBodyHeight - clampedScroll);
		visibleBodyLines = allBodyLines.slice(startIdx, startIdx + availableBodyHeight);
	}

	const output: string[] = [];
	output.push(text.truncateToWidth(tabLine, width));
	output.push(text.truncateToWidth(metaLine, width));
	for (const line of visibleBodyLines) {
		output.push(text.truncateToWidth(line, width));
	}
	while (output.length < height - 1) {
		output.push("");
	}
	output.push(text.truncateToWidth(helpLine, width));
	return output.slice(0, height);
}

export interface RenderRequester {
	requestRender(): void;
	terminal?: { rows?: number };
}

function checkKey(data: string, key: string): boolean {
	try {
		return matchesKey(data, key as any);
	} catch {
		return false;
	}
}

export class InspectorComponent implements Component {
	private readonly state: InspectorState = {
		selectedIndex: 0,
		scrollOffset: 0,
		follow: true,
	};
	private readonly dashboard: PanelDashboardStore;
	private readonly transcripts: PanelTranscriptStore;
	private readonly tui: RenderRequester;
	private readonly theme: DashboardTheme;
	private readonly onClose: () => void;
	private readonly onAbort?: () => void;
	private readonly text: TerminalText;
	private lastWidth = 80;
	private unsubDashboard: (() => void) | undefined;
	private unsubTranscripts: (() => void) | undefined;

	constructor(
		dashboard: PanelDashboardStore,
		transcripts: PanelTranscriptStore,
		tui: RenderRequester,
		theme: DashboardTheme,
		onClose: () => void,
		onAbort?: () => void,
		text: TerminalText = fallbackTerminalText,
	) {
		this.dashboard = dashboard;
		this.transcripts = transcripts;
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.onAbort = onAbort;
		this.text = text;

		this.unsubDashboard = this.dashboard.subscribe(() => this.tui.requestRender());
		this.unsubTranscripts = this.transcripts.subscribe(() => this.tui.requestRender());
	}

	getState(): Readonly<InspectorState> {
		return this.state;
	}

	private getMaxScroll(): number {
		const termRows = this.tui.terminal?.rows ?? 24;
		const height = Math.max(8, Math.floor(termRows * 0.8));
		const availableBodyHeight = Math.max(1, height - 3);
		const bodyLines = computeInspectorBodyLines(
			this.dashboard,
			this.transcripts,
			this.state.selectedIndex,
			this.lastWidth,
			this.theme,
			this.text,
		);
		return Math.max(0, bodyLines.length - availableBodyHeight);
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const termRows = this.tui.terminal?.rows ?? 24;
		const height = Math.max(8, Math.floor(termRows * 0.8));
		return renderInspector(
			this.dashboard,
			this.transcripts,
			this.state,
			width,
			height,
			this.theme,
			this.text,
		);
	}

	invalidate(): void {
		// No cached render state
	}

	handleInput(data: string): void {
		if (
			checkKey(data, "ctrl+shift+x") ||
			checkKey(data, "ctrl+x") ||
			matchesKey(data, "ctrl+shift+x" as any) ||
			data === "\x18"
		) {
			this.onAbort?.();
			return;
		}

		if (checkKey(data, "escape") || data === "\x1b") {
			this.onClose();
			return;
		}

		const rows = this.dashboard.getRows();
		const count = rows.length;

		if (checkKey(data, "left") || checkKey(data, "shift+tab") || data === "\x1b[D" || data === "\x1b[Z") {
			if (count > 0) {
				this.state.selectedIndex = (this.state.selectedIndex - 1 + count) % count;
				this.state.scrollOffset = 0;
				this.state.follow = true;
				this.tui.requestRender();
			}
			return;
		}

		if (checkKey(data, "right") || checkKey(data, "tab") || data === "\x1b[C" || data === "\t") {
			if (count > 0) {
				this.state.selectedIndex = (this.state.selectedIndex + 1) % count;
				this.state.scrollOffset = 0;
				this.state.follow = true;
				this.tui.requestRender();
			}
			return;
		}

		if (checkKey(data, "up") || data === "\x1b[A") {
			const maxScroll = this.getMaxScroll();
			this.state.scrollOffset = Math.min(maxScroll, this.state.scrollOffset + 1);
			this.state.follow = false;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "down") || data === "\x1b[B") {
			this.state.scrollOffset = Math.max(0, this.state.scrollOffset - 1);
			if (this.state.scrollOffset === 0) this.state.follow = true;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "pageUp") || checkKey(data, "pageup") || data === "\x1b[5~") {
			const maxScroll = this.getMaxScroll();
			this.state.scrollOffset = Math.min(maxScroll, this.state.scrollOffset + 10);
			this.state.follow = false;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "pageDown") || checkKey(data, "pagedown") || data === "\x1b[6~") {
			this.state.scrollOffset = Math.max(0, this.state.scrollOffset - 10);
			if (this.state.scrollOffset === 0) this.state.follow = true;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "home") || data === "g" || data === "\x1b[H") {
			this.state.scrollOffset = this.getMaxScroll();
			this.state.follow = false;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "end") || data === "G" || data === "\x1b[F") {
			this.state.scrollOffset = 0;
			this.state.follow = true;
			this.tui.requestRender();
			return;
		}

		if (data === "f" || data === "F") {
			this.state.follow = !this.state.follow;
			if (this.state.follow) this.state.scrollOffset = 0;
			this.tui.requestRender();
			return;
		}
	}

	dispose(): void {
		this.unsubDashboard?.();
		this.unsubDashboard = undefined;
		this.unsubTranscripts?.();
		this.unsubTranscripts = undefined;
	}
}

export interface OpenInspectorOptions {
	text?: TerminalText;
	onAbort?: () => void;
}

export interface OpenInspectorResult {
	close(): void;
	closed: Promise<void>;
}

export function openInspector(
	ctx: ExtensionContext,
	dashboard: PanelDashboardStore,
	transcripts: PanelTranscriptStore,
	options: OpenInspectorOptions = {},
): OpenInspectorResult {
	const text = options.text ?? fallbackTerminalText;
	const onAbort = options.onAbort;
	let doneFn: (() => void) | undefined;
	let closedResolve!: () => void;
	const closed = new Promise<void>((resolve) => {
		closedResolve = resolve;
	});

	let component: InspectorComponent | undefined;

	const close = () => {
		if (doneFn) {
			const fn = doneFn;
			doneFn = undefined;
			component?.dispose();
			component = undefined;
			fn();
			closedResolve();
		}
	};

	ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			doneFn = () => done(undefined);
			component = new InspectorComponent(dashboard, transcripts, tui, theme, close, onAbort, text);
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				width: "80%",
				maxHeight: "80%",
				anchor: "center",
			},
		},
	).catch(() => {}).finally(() => {
		doneFn = undefined;
		component?.dispose();
		component = undefined;
		closedResolve();
	});

	return { close, closed };
}
