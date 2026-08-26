/**
 * Full-screen, read-only subagent console overlay shared by panel-review and
 * plan-implement.
 *
 * Replaces the old 80%×80% floating inspector popup. The console covers the
 * terminal edge-to-edge (`width: "100%", maxHeight: "100%", anchor: "top-left",
 * margin: 0`), so the exact height is `tui.terminal.rows` — there is no
 * fractional height guessing. Pi's renderer writes the final row without a
 * trailing newline, so covering the last terminal row does not scroll.
 *
 * Wide terminals (≥ 100 cols) render a bordered layout: title bar with run
 * elapsed and total cost, a per-child sidebar (status/model/turns/elapsed),
 * and a transcript pane. Narrow terminals fall back to the legacy tab-bar
 * layout. Both layouts are pure functions of {@link ConsoleState}.
 *
 * Scroll position and follow mode are remembered per child id, so switching
 * children restores that child's position instead of resetting to the tail.
 *
 * All displayed text is treated as untrusted: ANSI/OSC/APC sequences and
 * control characters (except newlines) are stripped, and every line is
 * truncated to the display width.
 *
 * Ephemeral only — nothing here is written to the session or disk, and this
 * module never changes store lifetime: the console still closes when the run
 * ends (the caller disposes it).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey } from "@earendil-works/pi-tui";
import { formatDuration } from "./child-agent-runner.ts";
import {
	type DashboardStatus,
	type DashboardTheme,
	formatCost,
	type RenderRequester,
	STATUS_ICON,
} from "./live-dashboard.ts";
import {
	fallbackTerminalText,
	sanitizeDisplayText,
	segmentGraphemesFallback,
	type TerminalText,
	visibleWidthFallback,
} from "./terminal-text.ts";
import { EVICTION_NOTICE, type TranscriptEntry } from "./transcript-store.ts";

export { formatCost };

interface ConsoleRow {
	id: string;
	label: string;
	model: string;
	status: DashboardStatus;
	turns: number;
	startedAt?: number;
	finishedAt?: number;
}

interface ConsoleDashboard {
	getRows(): readonly ConsoleRow[];
	nowMs(): number;
	subscribe(listener: () => void): () => void;
	/** Total run elapsed seconds (LiveDashboardStore provides this). */
	elapsedSeconds?(): number;
}

interface ConsoleTranscripts {
	getEntries(id: string): readonly TranscriptEntry[];
	getLiveTail(id: string): string | undefined;
	getTotalCost(id: string): number;
	wasEvicted(id: string): boolean;
	subscribe(listener: () => void): () => void;
}

interface ConsoleCopy {
	/** Console title shown in the wide-layout title bar. */
	title: string;
	emptyMessage: string;
	/** Extra help hint (e.g. the abort shortcut) appended to the help line. */
	helpSuffix?: string;
}

const DEFAULT_COPY: ConsoleCopy = { title: "Subagents", emptyMessage: "No subagents active" };

/** Scroll position of one child transcript; kept per child id. */
export interface ConsoleScrollState {
	scrollOffset: number; // lines from bottom; 0 = at tail
	follow: boolean;
}

export interface ConsoleState {
	selectedIndex: number;
	scroll: Map<string, ConsoleScrollState>;
}

/** Minimum terminal width for the bordered sidebar layout. */
export const WIDE_MIN_WIDTH = 100;

/** Geometry shared by rendering and scroll clamping — the single source of truth. */
interface ConsoleViewport {
	wide: boolean;
	/** Lines available to sidebar/transcript body rows. */
	bodyHeight: number;
	/** Sidebar cell width in cols (0 in narrow mode). */
	sidebarWidth: number;
	/** Transcript cell width in cols (narrow mode: the full width). */
	transcriptWidth: number;
}

const WIDE_CHROME_LINES = 3; // title border, help, bottom border
const NARROW_CHROME_LINES = 3; // tab bar, meta line, help
const MIN_SIDEBAR_WIDTH = 34;
const MAX_SIDEBAR_WIDTH = 48;

export function computeViewport(width: number, height: number): ConsoleViewport {
	const safeHeight = Math.max(4, height);
	if (width >= WIDE_MIN_WIDTH) {
		const targetWidth = Math.floor((width - 3) * 0.28);
		const sidebarWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, targetWidth));
		return {
			wide: true,
			bodyHeight: Math.max(1, safeHeight - WIDE_CHROME_LINES),
			sidebarWidth,
			transcriptWidth: Math.max(10, width - sidebarWidth - 3),
		};
	}
	return {
		wide: false,
		bodyHeight: Math.max(1, safeHeight - NARROW_CHROME_LINES),
		sidebarWidth: 0,
		transcriptWidth: Math.max(10, width),
	};
}

function rowElapsedSeconds(row: ConsoleRow, now: number): number | undefined {
	if (row.startedAt === undefined) return undefined;
	return Math.max(0, Math.round(((row.finishedAt ?? now) - row.startedAt) / 1000));
}

/** Format token counts compactly (e.g. 12.4k or 800). */
export function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	const k = count / 1000;
	return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
}

/** Format elapsed seconds compactly (e.g. 45s, 3m12s, 1h04m). */
export function formatElapsedSeconds(totalSeconds: number): string {
	const seconds = Math.max(0, Math.round(totalSeconds));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Sanitize untrusted child text preserving newlines for multiline display.
 * Strips ANSI/OSC/APC and C0/C1 control characters except newline.
 */
export function sanitizeMultilineText(input: string, text: TerminalText = fallbackTerminalText): string {
	const stripped = text.stripTerminalSequences(input);
	return stripped
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize terminal control characters except newlines
			/[\x00-\x09\x0b-\x1f\x7f-\x9f]+/g,
			" ",
		);
}

type WidthMeasurer = (text: string) => number;

function widthMeasurer(text: TerminalText): WidthMeasurer {
	const measure = text.visibleWidth ?? visibleWidthFallback;
	return (value) => measure(value);
}

/** Break one sanitized line into chunks that fit within the display width. */
function wrapPlainLine(line: string, width: number, widthOf: WidthMeasurer, breakOnDelimiters = false): string[] {
	if (width <= 0) return [];
	if (line === "") return [""];
	if (widthOf(line) <= width) return [line];
	const out: string[] = [];
	let rest = line;
	while (rest !== "" && widthOf(rest) > width) {
		let prefix = "";
		let prefixWidth = 0;
		let lastSpace = -1;
		let lastBreak = -1;
		const graphemes = Array.from(segmentGraphemesFallback(rest));
		for (const grapheme of graphemes) {
			const graphemeWidth = widthOf(grapheme);
			if (prefixWidth + graphemeWidth > width) break;
			prefix += grapheme;
			prefixWidth += graphemeWidth;
			if (/^\s$/u.test(grapheme)) {
				lastSpace = prefix.length - grapheme.length;
			} else if (breakOnDelimiters && /^[/_\-:]$/u.test(grapheme)) {
				lastBreak = prefix.length;
			}
		}
		if (prefix === "") {
			// A single grapheme wider than the viewport: emit it anyway to make progress.
			const first = graphemes[0];
			if (first === undefined) break;
			out.push(first);
			rest = rest.slice(first.length);
			continue;
		}
		if (lastSpace > 0) {
			out.push(prefix.slice(0, lastSpace));
			rest = rest.slice(lastSpace + 1);
		} else if (breakOnDelimiters && lastBreak > 0) {
			out.push(prefix.slice(0, lastBreak));
			rest = rest.slice(lastBreak);
		} else {
			out.push(prefix);
			rest = rest.slice(prefix.length);
		}
		rest = rest.trimStart();
	}
	if (rest !== "") out.push(rest);
	return out;
}

/** Break raw text into wrapped lines that fit within the display width. */
export function wrapAndSanitizeText(
	rawText: string,
	width: number,
	text: TerminalText = fallbackTerminalText,
): string[] {
	if (width <= 0) return [];
	const widthOf = widthMeasurer(text);
	const safe = sanitizeMultilineText(rawText, text);
	const result: string[] = [];
	for (const line of safe.split("\n")) {
		for (const wrapped of wrapPlainLine(line, width, widthOf)) {
			result.push(wrapped);
		}
	}
	return result;
}

function selectedScroll(state: ConsoleState, id: string): ConsoleScrollState {
	return state.scroll.get(id) ?? { scrollOffset: 0, follow: true };
}

/** Sum turn costs across every child (used by the wide title bar). */
function totalCost(dashboard: ConsoleDashboard, transcripts: ConsoleTranscripts): number {
	let sum = 0;
	for (const row of dashboard.getRows()) sum += transcripts.getTotalCost(row.id);
	return sum;
}

/** Cost of the currently selected child (used by the narrow meta line). */
function childCost(transcripts: ConsoleTranscripts, id: string): number {
	return transcripts.getTotalCost(id);
}

/** Compute flattened formatted transcript lines for the selected child. */
function computeTranscriptLines(
	dashboard: ConsoleDashboard,
	transcripts: ConsoleTranscripts,
	selectedIndex: number,
	wrapWidth: number,
	theme: DashboardTheme,
	text: TerminalText,
): string[] {
	const rows = dashboard.getRows();
	if (rows.length === 0) {
		return [theme.fg("dim", "(no transcript yet)")];
	}
	const clampedIndex = Math.max(0, Math.min(selectedIndex, rows.length - 1));
	const selectedId = rows[clampedIndex].id;

	const bodyLines: string[] = [];
	if (transcripts.wasEvicted(selectedId)) {
		bodyLines.push(theme.fg("warning", EVICTION_NOTICE));
	}

	for (const entry of transcripts.getEntries(selectedId)) {
		switch (entry.kind) {
			case "note": {
				const safe = sanitizeDisplayText(entry.text, text);
				bodyLines.push(theme.fg("dim", `— ${safe}`));
				break;
			}
			case "tool": {
				let line = `${theme.fg("accent", "●")} ${theme.fg("muted", sanitizeDisplayText(entry.summary, text))}`;
				if (entry.durationMs !== undefined) {
					line += ` ${theme.fg("dim", `· ${formatDuration(entry.durationMs)}`)}`;
				}
				bodyLines.push(line);
				break;
			}
			case "turn": {
				const u = entry.usage;
				let turnLine = `— turn ${entry.turn} · in ${formatTokens(u.input)} out ${formatTokens(u.output)}`;
				if (u.cost > 0) {
					turnLine += ` · ${formatCost(u.cost)}`;
				}
				bodyLines.push(theme.fg("dim", turnLine));
				break;
			}
			case "text": {
				for (const wrapped of wrapAndSanitizeText(entry.text, wrapWidth, text)) {
					bodyLines.push(wrapped);
				}
				break;
			}
		}
	}

	const liveTail = transcripts.getLiveTail(selectedId);
	if (liveTail) {
		for (const wrapped of wrapAndSanitizeText(liveTail, wrapWidth, text)) {
			bodyLines.push(theme.fg("dim", wrapped));
		}
	}

	if (bodyLines.length === 0) {
		bodyLines.push(theme.fg("dim", "(no transcript yet)"));
	}

	return bodyLines;
}

/** Apply follow/scroll windowing to a list of body lines. */
function windowBodyLines(bodyLines: string[], scroll: ConsoleScrollState, bodyHeight: number): string[] {
	if (scroll.follow) {
		return bodyLines.slice(Math.max(0, bodyLines.length - bodyHeight));
	}
	const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
	const clampedScroll = Math.max(0, Math.min(scroll.scrollOffset, maxScroll));
	const startIdx = Math.max(0, bodyLines.length - bodyHeight - clampedScroll);
	return bodyLines.slice(startIdx, startIdx + bodyHeight);
}

function helpText(copy: ConsoleCopy, follow: boolean): string {
	return `↑↓/←→/tab child · PgUp PgDn scroll · f follow [${follow ? "ON" : "OFF"}] · esc close${copy.helpSuffix ?? ""}`;
}

/** Narrow layout: legacy tab bar + meta line + windowed body + help. */
function renderNarrow(
	dashboard: ConsoleDashboard,
	transcripts: ConsoleTranscripts,
	state: ConsoleState,
	width: number,
	height: number,
	theme: DashboardTheme,
	text: TerminalText,
	copy: ConsoleCopy,
): string[] {
	const rows = dashboard.getRows();
	const clampedIndex = Math.max(0, Math.min(state.selectedIndex, rows.length - 1));
	const selectedRow = rows[clampedIndex];
	const scroll = selectedScroll(state, selectedRow.id);
	const viewport = computeViewport(width, height);

	const tabs = rows.map((row, index) => {
		const { icon, color } = STATUS_ICON[row.status];
		const safeLabel = sanitizeDisplayText(row.label, text);
		const iconStr = theme.fg(color, icon);
		if (index === clampedIndex) {
			return `${iconStr} ${theme.fg("accent", safeLabel)}`;
		}
		return `${iconStr} ${theme.fg("muted", safeLabel)}`;
	});
	const tabLine = tabs.join("   ");

	const safeModel = sanitizeDisplayText(selectedRow.model, text);
	const elapsed = rowElapsedSeconds(selectedRow, dashboard.nowMs());
	const metaParts: string[] = [safeModel, selectedRow.status, `${selectedRow.turns}t`];
	if (elapsed !== undefined) metaParts.push(`${elapsed}s`);
	const cost = childCost(transcripts, selectedRow.id);
	if (cost > 0) metaParts.push(formatCost(cost));
	const metaLine = theme.fg("dim", `— ${metaParts.join(" · ")} —`);

	const bodyLines = computeTranscriptLines(
		dashboard,
		transcripts,
		clampedIndex,
		Math.max(10, viewport.transcriptWidth - 2),
		theme,
		text,
	);
	const visibleBodyLines = windowBodyLines(bodyLines, scroll, viewport.bodyHeight);

	const output: string[] = [];
	output.push(text.truncateToWidth(tabLine, width));
	output.push(text.truncateToWidth(metaLine, width));
	for (const line of visibleBodyLines) {
		output.push(text.truncateToWidth(line, width));
	}
	while (output.length < height - 1) {
		output.push("");
	}
	output.push(text.truncateToWidth(theme.fg("dim", helpText(copy, scroll.follow)), width));
	return output.slice(0, height);
}

interface SidebarChildBlock {
	lines: string[];
}

/** Compute sidebar blocks per child: icon+label, wrapped model name, and status/turns/elapsed/cost meta line. */
function computeSidebarBlocks(
	dashboard: ConsoleDashboard,
	transcripts: ConsoleTranscripts,
	selectedIndex: number,
	sidebarWidth: number,
	theme: DashboardTheme,
	text: TerminalText,
): SidebarChildBlock[] {
	const rows = dashboard.getRows();
	const now = dashboard.nowMs();
	const widthOf = widthMeasurer(text);
	const innerWidth = Math.max(10, sidebarWidth - 1);
	const blocks: SidebarChildBlock[] = [];

	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const { icon, color } = STATUS_ICON[row.status];
		const safeLabel = sanitizeDisplayText(row.label, text);
		const isSelected = index === selectedIndex;
		const labelColor = isSelected ? "accent" : "muted";
		const subColor = isSelected ? "muted" : "dim";

		const lines: string[] = [];
		lines.push(`${theme.fg(color, icon)} ${theme.fg(labelColor, safeLabel)}`);

		const safeModel = sanitizeDisplayText(row.model, text);
		const modelWrapWidth = Math.max(6, innerWidth - 2);
		const wrappedModelLines = wrapPlainLine(safeModel, modelWrapWidth, widthOf, true);
		for (const mLine of wrappedModelLines) {
			lines.push(theme.fg(subColor, `  ${mLine}`));
		}

		const metaParts: string[] = [row.status];
		if (row.turns > 0) metaParts.push(`${row.turns}t`);
		const elapsed = rowElapsedSeconds(row, now);
		if (elapsed !== undefined && (elapsed > 0 || row.status === "completed" || row.status === "running")) {
			metaParts.push(`${elapsed}s`);
		}
		const cost = transcripts.getTotalCost(row.id);
		if (cost > 0) metaParts.push(formatCost(cost));

		lines.push(theme.fg(subColor, `  ${metaParts.join(" · ")}`));
		blocks.push({ lines });
	}

	return blocks;
}

/** Window sidebar blocks so the selected child stays visible within bodyHeight. */
function windowSidebarBlocks(
	blocks: readonly SidebarChildBlock[],
	selectedIndex: number,
	bodyHeight: number,
): string[] {
	if (blocks.length === 0) return [];

	const blockStarts: number[] = [];
	const flatLines: string[] = [];
	for (const block of blocks) {
		blockStarts.push(flatLines.length);
		for (const line of block.lines) {
			flatLines.push(line);
		}
	}

	if (flatLines.length <= bodyHeight) {
		return flatLines;
	}

	const clampedIndex = Math.max(0, Math.min(selectedIndex, blocks.length - 1));
	const selStart = blockStarts[clampedIndex] ?? 0;
	const selLen = blocks[clampedIndex]?.lines.length ?? 1;
	const selEnd = selStart + selLen;

	if (bodyHeight < selLen) {
		// When body height cannot fit the full child block, keep the child's label line visible.
		return flatLines.slice(selStart, selStart + bodyHeight);
	}

	let start = Math.min(selStart, Math.max(0, flatLines.length - bodyHeight));
	if (selEnd > start + bodyHeight) {
		start = Math.max(0, selEnd - bodyHeight);
	}

	return flatLines.slice(start, start + bodyHeight);
}

/** Truncate and pad cell content to an exact cell width. */
function fitCell(content: string | undefined, cellWidth: number, text: TerminalText, widthOf: WidthMeasurer): string {
	const inner = content === undefined ? "" : text.truncateToWidth(content, Math.max(0, cellWidth - 1));
	const padded = widthOf(inner) >= cellWidth - 1 ? inner : inner + " ".repeat(cellWidth - 1 - widthOf(inner));
	return ` ${padded}`;
}

/** Wide layout: bordered title bar, sidebar + transcript pane, help, bottom border. */
function renderWide(
	dashboard: ConsoleDashboard,
	transcripts: ConsoleTranscripts,
	state: ConsoleState,
	width: number,
	height: number,
	theme: DashboardTheme,
	text: TerminalText,
	copy: ConsoleCopy,
): string[] {
	const rows = dashboard.getRows();
	const clampedIndex = Math.max(0, Math.min(state.selectedIndex, rows.length - 1));
	const selectedRow = rows[clampedIndex];
	const scroll = selectedScroll(state, selectedRow.id);
	const viewport = computeViewport(width, height);
	const widthOf = widthMeasurer(text);
	const border = (s: string) => theme.fg("border", s);

	// Title bar: ┌ <title> · <elapsed> · <cost> ────────┐
	const titleParts: string[] = [];
	if (dashboard.elapsedSeconds !== undefined) {
		titleParts.push(formatElapsedSeconds(dashboard.elapsedSeconds()));
	}
	const cost = totalCost(dashboard, transcripts);
	if (cost > 0) titleParts.push(formatCost(cost));
	let titleLabel = ` ${theme.fg("accent", copy.title)}`;
	if (titleParts.length > 0) titleLabel += theme.fg("dim", ` · ${titleParts.join(" · ")}`);
	titleLabel += " ";
	const fillWidth = Math.max(0, width - 2 - widthOf(titleLabel));
	const titleLine = border("┌") + titleLabel + border("─".repeat(fillWidth)) + border("┐");

	// Body rows: sidebar window + transcript window assembled into bordered cells.
	const sidebarBlocks = computeSidebarBlocks(dashboard, transcripts, clampedIndex, viewport.sidebarWidth, theme, text);
	const sidebarLines = windowSidebarBlocks(sidebarBlocks, clampedIndex, viewport.bodyHeight);
	const transcriptLines = computeTranscriptLines(
		dashboard,
		transcripts,
		clampedIndex,
		Math.max(10, viewport.transcriptWidth - 2),
		theme,
		text,
	);
	const visibleTranscript = windowBodyLines(transcriptLines, scroll, viewport.bodyHeight);

	const output: string[] = [];
	output.push(text.truncateToWidth(titleLine, width));
	for (let i = 0; i < viewport.bodyHeight; i++) {
		const sidebarCell = fitCell(sidebarLines[i], viewport.sidebarWidth, text, widthOf);
		const transcriptCell = fitCell(visibleTranscript[i], viewport.transcriptWidth, text, widthOf);
		output.push(text.truncateToWidth(border("│") + sidebarCell + border("│") + transcriptCell + border("│"), width));
	}
	const helpCell = fitCell(theme.fg("dim", helpText(copy, scroll.follow)), width - 2, text, widthOf);
	output.push(text.truncateToWidth(border("│") + helpCell + border("│"), width));
	output.push(text.truncateToWidth(border("└") + border("─".repeat(Math.max(0, width - 2))) + border("┘"), width));
	return output.slice(0, Math.max(4, height));
}

/**
 * Pure renderer: produces width-safe, themed console lines, exactly `height`
 * of them (except the empty-dashboard fallback, which is a single line).
 */
export function renderSubagentConsole(
	dashboard: ConsoleDashboard,
	transcripts: ConsoleTranscripts,
	state: ConsoleState,
	width: number,
	height: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
	copy: ConsoleCopy = DEFAULT_COPY,
): string[] {
	const rows = dashboard.getRows();
	if (rows.length === 0) {
		return [text.truncateToWidth(theme.fg("muted", copy.emptyMessage), width)];
	}
	if (computeViewport(width, height).wide) {
		return renderWide(dashboard, transcripts, state, width, height, theme, text, copy);
	}
	return renderNarrow(dashboard, transcripts, state, width, height, theme, text, copy);
}

export function parseWheelDirection(data: string): -1 | 1 | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: match terminal mouse sequences
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1], 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction === 0) return -1;
		if (direction === 1) return 1;
		return undefined;
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction === 0) return -1;
		if (direction === 1) return 1;
		return undefined;
	}
	return undefined;
}

function checkKey(data: string, key: Parameters<typeof matchesKey>[1]): boolean {
	try {
		return matchesKey(data, key);
	} catch {
		return false;
	}
}

export class SubagentConsoleComponent implements Component {
	private readonly state: ConsoleState = {
		selectedIndex: 0,
		scroll: new Map(),
	};
	private readonly dashboard: ConsoleDashboard;
	private readonly transcripts: ConsoleTranscripts;
	private readonly tui: RenderRequester;
	private readonly theme: DashboardTheme;
	private readonly onClose: () => void;
	private readonly onAbort?: () => void;
	private readonly isAbortInput: (data: string) => boolean;
	private readonly text: TerminalText;
	private readonly copy: ConsoleCopy;
	private lastWidth = 80;
	private lastHeight = 24;
	private lastBodyLineCounts = new Map<string, number>();
	private unsubDashboard: (() => void) | undefined;
	private unsubTranscripts: (() => void) | undefined;

	constructor(
		dashboard: ConsoleDashboard,
		transcripts: ConsoleTranscripts,
		tui: RenderRequester,
		theme: DashboardTheme,
		onClose: () => void,
		onAbort?: () => void,
		text: TerminalText = fallbackTerminalText,
		copy: ConsoleCopy = DEFAULT_COPY,
		isAbortInput: (data: string) => boolean = () => false,
	) {
		this.dashboard = dashboard;
		this.transcripts = transcripts;
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.onAbort = onAbort;
		this.isAbortInput = isAbortInput;
		this.text = text;
		this.copy = copy;

		this.unsubDashboard = this.dashboard.subscribe(() => this.tui.requestRender());
		this.unsubTranscripts = this.transcripts.subscribe(() => {
			const id = this.selectedId();
			if (id !== undefined) this.anchorScrolledViewport(id);
			this.tui.requestRender();
		});
	}

	getState(): Readonly<ConsoleState> {
		return this.state;
	}

	/** Full-screen overlay: the terminal row count is the exact height. */
	private height(): number {
		return Math.max(4, this.tui.terminal?.rows ?? 24);
	}

	private scrollFor(id: string): ConsoleScrollState {
		let scroll = this.state.scroll.get(id);
		if (!scroll) {
			scroll = { scrollOffset: 0, follow: true };
			this.state.scroll.set(id, scroll);
		}
		return scroll;
	}

	private selectedId(): string | undefined {
		const rows = this.dashboard.getRows();
		if (rows.length === 0) return undefined;
		const clampedIndex = Math.max(0, Math.min(this.state.selectedIndex, rows.length - 1));
		return rows[clampedIndex].id;
	}

	private bodyLineCount(id: string, viewport: ConsoleViewport): number {
		const rows = this.dashboard.getRows();
		const selectedIndex = rows.findIndex((row) => row.id === id);
		if (selectedIndex < 0) return 0;
		return computeTranscriptLines(
			this.dashboard,
			this.transcripts,
			selectedIndex,
			Math.max(10, viewport.transcriptWidth - 2),
			this.theme,
			this.text,
		).length;
	}

	private rememberBodyLineCount(id: string, viewport: ConsoleViewport): void {
		this.lastBodyLineCounts.set(id, this.bodyLineCount(id, viewport));
	}

	private anchorScrolledViewport(id: string): void {
		const scroll = this.state.scroll.get(id);
		if (!scroll) return;
		const viewport = computeViewport(this.lastWidth, this.lastHeight);
		const nextCount = this.bodyLineCount(id, viewport);
		const previousCount = this.lastBodyLineCounts.get(id) ?? nextCount;
		if (!scroll.follow && nextCount > previousCount) {
			scroll.scrollOffset = Math.min(
				Math.max(0, nextCount - viewport.bodyHeight),
				scroll.scrollOffset + nextCount - previousCount,
			);
		}
		this.lastBodyLineCounts.set(id, nextCount);
	}

	private getMaxScroll(): number {
		const viewport = computeViewport(this.lastWidth, this.lastHeight);
		const id = this.selectedId();
		return id === undefined ? 0 : Math.max(0, this.bodyLineCount(id, viewport) - viewport.bodyHeight);
	}

	render(width: number): string[] {
		this.lastWidth = width;
		this.lastHeight = this.height();
		const viewport = computeViewport(width, this.lastHeight);
		const id = this.selectedId();
		if (id !== undefined) this.rememberBodyLineCount(id, viewport);
		return renderSubagentConsole(
			this.dashboard,
			this.transcripts,
			this.state,
			width,
			this.lastHeight,
			this.theme,
			this.text,
			this.copy,
		);
	}

	invalidate(): void {
		// No cached render state
	}

	handleInput(data: string): void {
		if (this.isAbortInput(data)) {
			this.onAbort?.();
			return;
		}

		if (checkKey(data, "escape") || data === "q" || data === "Q") {
			this.onClose();
			return;
		}

		const rows = this.dashboard.getRows();
		const count = rows.length;

		if (checkKey(data, "up") || checkKey(data, "left") || checkKey(data, "shift+tab") || data === "k") {
			if (count > 0) {
				this.state.selectedIndex = (this.state.selectedIndex - 1 + count) % count;
				const id = this.selectedId();
				if (id !== undefined) {
					this.scrollFor(id);
					this.anchorScrolledViewport(id);
				}
				this.tui.requestRender();
			}
			return;
		}

		if (checkKey(data, "down") || checkKey(data, "right") || checkKey(data, "tab") || data === "j") {
			if (count > 0) {
				this.state.selectedIndex = (this.state.selectedIndex + 1) % count;
				const id = this.selectedId();
				if (id !== undefined) {
					this.scrollFor(id);
					this.anchorScrolledViewport(id);
				}
				this.tui.requestRender();
			}
			return;
		}

		const id = this.selectedId();
		if (id === undefined) return;
		const scroll = this.scrollFor(id);

		const wheelDir = parseWheelDirection(data);
		if (wheelDir !== undefined) {
			if (wheelDir < 0) {
				scroll.scrollOffset = Math.min(this.getMaxScroll(), scroll.scrollOffset + 3);
				scroll.follow = false;
				this.tui.requestRender();
				return;
			}
			if (wheelDir > 0) {
				scroll.scrollOffset = Math.max(0, scroll.scrollOffset - 3);
				if (scroll.scrollOffset === 0) scroll.follow = true;
				this.tui.requestRender();
				return;
			}
		}

		const pageStep = Math.max(1, this.height() - WIDE_CHROME_LINES - 2);

		if (checkKey(data, "pageUp") || checkKey(data, "ctrl+u") || checkKey(data, "ctrl+b")) {
			scroll.scrollOffset = Math.min(this.getMaxScroll(), scroll.scrollOffset + pageStep);
			scroll.follow = false;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "pageDown") || checkKey(data, "ctrl+d") || checkKey(data, "ctrl+f")) {
			scroll.scrollOffset = Math.max(0, scroll.scrollOffset - pageStep);
			if (scroll.scrollOffset === 0) scroll.follow = true;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "home") || data === "g") {
			scroll.scrollOffset = this.getMaxScroll();
			scroll.follow = false;
			this.tui.requestRender();
			return;
		}

		if (checkKey(data, "end") || data === "G") {
			scroll.scrollOffset = 0;
			scroll.follow = true;
			this.tui.requestRender();
			return;
		}

		if (data === "f" || data === "F") {
			scroll.follow = !scroll.follow;
			if (scroll.follow) scroll.scrollOffset = 0;
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

interface OpenSubagentConsoleOptions {
	text?: TerminalText;
	onAbort?: () => void;
	isAbortInput?: (data: string) => boolean;
	copy?: ConsoleCopy;
}

export interface OpenSubagentConsoleResult {
	close(): void;
	closed: Promise<void>;
}

export function openSubagentConsole(
	ctx: ExtensionContext,
	dashboard: ConsoleDashboard,
	transcripts: ConsoleTranscripts,
	options: OpenSubagentConsoleOptions = {},
): OpenSubagentConsoleResult {
	const text = options.text ?? fallbackTerminalText;
	const onAbort = options.onAbort;
	const isAbortInput = options.isAbortInput;
	let doneFn: (() => void) | undefined;
	let closedResolve!: () => void;
	const closed = new Promise<void>((resolve) => {
		closedResolve = resolve;
	});

	let component: SubagentConsoleComponent | undefined;

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

	ctx.ui
		.custom<void>(
			(tui, theme, _kb, done) => {
				doneFn = () => done(undefined);
				component = new SubagentConsoleComponent(
					dashboard,
					transcripts,
					tui,
					theme,
					close,
					onAbort,
					text,
					options.copy,
					isAbortInput,
				);
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "100%",
					maxHeight: "100%",
					anchor: "top-left",
					margin: 0,
				},
			},
		)
		.catch(() => {})
		.finally(() => {
			doneFn = undefined;
			component?.dispose();
			component = undefined;
			closedResolve();
		});

	return { close, closed };
}
