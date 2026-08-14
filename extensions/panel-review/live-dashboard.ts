/**
 * Live panel-review dashboard for TUI mode.
 *
 * A non-focusable widget mounted above the editor via ctx.ui.setWidget().
 * Shows one compact card per child (reviewers + lead synthesis) with state,
 * turns, activity, and a bounded rolling preview of visible assistant text.
 *
 * All displayed child/repository text is treated as untrusted: ANSI/OSC/APC
 * sequences and control characters are stripped before theming, and every
 * rendered line is truncated to the terminal width.
 *
 * Live state is ephemeral — nothing here is written to the session. The
 * durable artifact remains the final "panel-review" custom message.
 */

import type { Component } from "@earendil-works/pi-tui";

/**
 * Terminal text helpers. In TUI mode index.ts injects pi-tui's
 * stripTerminalSequences/truncateToWidth; the local fallbacks below keep the
 * module importable (and testable) outside the Pi extension host, where
 * pi-tui is not resolvable.
 */
export interface TerminalText {
	stripTerminalSequences(text: string): string;
	truncateToWidth(text: string, width: number): string;
}

/** strip-ansi–style pattern: CSI sequences and other ESC-initiated two-byte forms. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
const ANSI_PATTERN =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** OSC/DCS/APC/PM/SOS payloads: ESC ] P X ^ _ or C1 0x90/0x98/0x9d-0x9f … BEL, ST (ESC \\), or C1 ST. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
const OSC_PATTERN = /(?:\u001B[\]PX^_]|[\u0090\u0098\u009d-\u009f]).*?(?:\u0007|\u001B\\|\u009c|$)/gs;

/** Strip ANSI/OSC/APC/DCS sequences. Exported for tests; production uses pi-tui's stripTerminalSequences. */
export function stripTerminalSequencesFallback(input: string): string {
	return input.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

/** Approximate cell width of a code point (wide/combining aware, ANSI-free input). Exported for tests. */
export function codePointWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacriticals
	if (cp < 0x1100) return 1;
	return cp <= 0x115f || // Hangul Jamo
		cp === 0x2329 ||
		cp === 0x232a ||
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
		(cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental emoji
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
		? 2
		: 1;
}

/** Fallback width-safe truncation for ANSI-free text (production uses pi-tui's truncateToWidth). */
function fallbackTruncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let used = 0;
	for (const ch of text) {
		const w = codePointWidth(ch.codePointAt(0) ?? 0);
		if (used + w > width) {
			let out = "";
			let kept = 0;
			for (const c of text) {
				const cw = codePointWidth(c.codePointAt(0) ?? 0);
				if (kept + cw > width - 1) break;
				out += c;
				kept += cw;
			}
			return out + "…";
		}
		used += w;
	}
	return text;
}

const fallbackTerminalText: TerminalText = {
	stripTerminalSequences: stripTerminalSequencesFallback,
	truncateToWidth: fallbackTruncateToWidth,
};

export type DashboardStatus = "queued" | "running" | "completed" | "failed" | "aborted";

type DashboardRole = "reviewer" | "lead";

export interface DashboardRow {
	id: string;
	label: string;
	model: string;
	role: DashboardRole;
	status: DashboardStatus;
	turns: number;
	activity?: string;
	/** Bounded rolling tail of visible assistant text (already byte-capped by the runner). */
	preview?: string;
	error?: string;
	/** Epoch ms when the child started running. */
	startedAt?: number;
	/** Epoch ms when the child reached a terminal status. */
	finishedAt?: number;
}

/** Minimal theme surface so tests can render without a full Pi theme. */
export interface DashboardTheme {
	fg(color: string, text: string): string;
}

/** Sanitize untrusted child/repository text for a single-line terminal display. */
export function sanitizeDisplayText(input: string, text: TerminalText = fallbackTerminalText): string {
	const stripped = text.stripTerminalSequences(input);
	// Drop C0/C1 control characters (incl. newlines), collapse whitespace.
	return stripped
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export const STATUS_ICON: Record<DashboardStatus, { icon: string; color: string }> = {
	queued: { icon: "○", color: "dim" },
	running: { icon: "●", color: "accent" },
	completed: { icon: "✓", color: "success" },
	failed: { icon: "✗", color: "error" },
	aborted: { icon: "⊘", color: "warning" },
};

export function rowElapsedSeconds(row: DashboardRow, now: number): number | undefined {
	if (row.startedAt === undefined) return undefined;
	const end = row.finishedAt ?? now;
	return Math.max(0, Math.round((end - row.startedAt) / 1000));
}

/**
 * Synchronous store for per-child dashboard state. Emits to subscribers on
 * every change so the mounted component can request a re-render.
 */
export class PanelDashboardStore {
	private rows: DashboardRow[] = [];
	private listeners = new Set<() => void>();
	readonly startedAt: number;

	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
		this.startedAt = now();
	}

	/** Current time in ms, from the injected clock. */
	nowMs(): number {
		return this.now();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	private find(id: string): DashboardRow | undefined {
		return this.rows.find((r) => r.id === id);
	}

	/** Seed a queued reviewer row before the panel starts. */
	addReviewer(id: string, label: string, model: string): void {
		this.rows.push({ id, label, model, role: "reviewer", status: "queued", turns: 0 });
		this.emit();
	}

	/** Seed or reveal the lead synthesis row. */
	addLead(id: string, label: string, model: string): void {
		const existing = this.find(id);
		if (existing) return;
		this.rows.push({ id, label, model, role: "lead", status: "queued", turns: 0 });
		this.emit();
	}

	markRunning(id: string): void {
		const row = this.find(id);
		if (!row) return;
		row.status = "running";
		row.startedAt = this.now();
		this.emit();
	}

	progress(id: string, info: { turns: number; activity?: string; preview?: string }): void {
		const row = this.find(id);
		if (!row || (row.status !== "running" && row.status !== "queued")) return;
		if (row.status === "queued") {
			row.status = "running";
			row.startedAt = this.now();
		}
		row.turns = info.turns;
		row.activity = info.activity;
		if (info.preview !== undefined) row.preview = info.preview;
		this.emit();
	}

	complete(id: string, result: { status: "completed" | "failed" | "aborted"; error?: string; turns?: number }): void {
		const row = this.find(id);
		if (!row) return;
		row.status = result.status;
		row.finishedAt = this.now();
		if (result.turns !== undefined) row.turns = result.turns;
		if (result.status === "failed" && result.error) row.error = result.error;
		row.activity = undefined;
		this.emit();
	}

	/** Re-emit so mounted components refresh elapsed-time displays. */
	tick(): void {
		this.emit();
	}

	getRows(): readonly DashboardRow[] {
		return this.rows;
	}

	summary(): { total: number; completed: number; failed: number; aborted: number; running: number } {
		let completed = 0;
		let failed = 0;
		let aborted = 0;
		let running = 0;
		for (const row of this.rows) {
			if (row.status === "completed") completed++;
			else if (row.status === "failed") failed++;
			else if (row.status === "aborted") aborted++;
			else if (row.status === "running") running++;
		}
		return { total: this.rows.length, completed, failed, aborted, running };
	}

	elapsedSeconds(): number {
		return Math.max(0, Math.round((this.now() - this.startedAt) / 1000));
	}
}

/**
 * Pure renderer: produces width-safe, themed dashboard lines for the current
 * store state. Exported for tests.
 */
export function renderDashboard(
	store: PanelDashboardStore,
	width: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
): string[] {
	const lines: string[] = [];
	const summary = store.summary();
	const done = summary.completed + summary.failed + summary.aborted;
	const header =
		theme.fg("success", "■ Panel review") +
		theme.fg("muted", ` — ${done}/${summary.total} done · ${store.elapsedSeconds()}s`) +
		theme.fg("dim", " — ^⇧V inspect · ^⇧X abort");
	lines.push(text.truncateToWidth(header, width));

	const showModel = width >= 60;
	const showActivity = width >= 40;
	const showPreview = width >= 24;

	for (const row of store.getRows()) {
		const { icon, color } = STATUS_ICON[row.status];
		const safeLabel = sanitizeDisplayText(row.label, text);
		const safeModel = sanitizeDisplayText(row.model, text);
		// State comes before model so truncation on narrow terminals always
		// retains the label and its status.
		let line = `${theme.fg(color, icon)} ${safeLabel}${theme.fg("muted", ` — ${row.status}`)}`;
		if (row.role === "lead") line += theme.fg("accent", " (lead synthesis)");
		else if (showModel) line += theme.fg("dim", ` (${safeModel})`);
		const elapsed = rowElapsedSeconds(row, store.nowMs());
		if (showActivity) {
			const meta: string[] = [];
			if (row.turns > 0) meta.push(`${row.turns}t`);
			if (elapsed !== undefined && elapsed > 0) meta.push(`${elapsed}s`);
			if (row.status === "running" && row.activity) meta.push(sanitizeDisplayText(row.activity, text));
			if (row.status === "failed" && row.error) meta.push(sanitizeDisplayText(row.error, text));
			if (meta.length > 0) line += theme.fg("dim", ` · ${meta.join(" · ")}`);
		}
		lines.push(text.truncateToWidth(line, width));

		if (showPreview && row.preview) {
			const preview = sanitizeDisplayText(row.preview, text);
			if (preview) {
				lines.push(text.truncateToWidth(`  ${theme.fg("muted", "›")} ${theme.fg("dim", preview)}`, width));
			}
		}
	}
	return lines;
}

interface RenderRequester {
	requestRender(): void;
}

/**
 * Non-focusable widget component subscribed to the store. dispose() is
 * idempotent and unsubscribes from store updates.
 */
export class PanelDashboardComponent implements Component {
	private unsubscribe: (() => void) | undefined;

	private readonly store: PanelDashboardStore;
	private readonly theme: DashboardTheme;
	private readonly text: TerminalText;

	constructor(
		store: PanelDashboardStore,
		tui: RenderRequester,
		theme: DashboardTheme,
		text: TerminalText = fallbackTerminalText,
	) {
		this.store = store;
		this.theme = theme;
		this.text = text;
		this.unsubscribe = store.subscribe(() => tui.requestRender());
	}

	render(width: number): string[] {
		return renderDashboard(this.store, width, this.theme, this.text);
	}

	invalidate(): void {
		// No cached render state; re-render happens via requestRender().
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

interface WidgetUi {
	setWidget(key: string, content: unknown): void;
}

/**
 * Mount the dashboard widget above the editor. Returns an idempotent
 * disposer that clears the widget and disposes the component.
 */
export function mountPanelDashboard(
	ui: WidgetUi,
	store: PanelDashboardStore,
	text: TerminalText = fallbackTerminalText,
): () => void {
	let component: PanelDashboardComponent | undefined;
	let disposed = false;
	ui.setWidget("panel-review", (tui: RenderRequester, theme: DashboardTheme) => {
		component = new PanelDashboardComponent(store, tui, theme, text);
		return component;
	});
	return () => {
		if (disposed) return;
		disposed = true;
		component?.dispose();
		component = undefined;
		ui.setWidget("panel-review", undefined);
	};
}
