/**
 * Live plan-implement dashboard for TUI mode.
 *
 * A non-focusable widget mounted above the editor via ctx.ui.setWidget().
 * Shows one compact card per child phase (planner, implementer, fixer,
 * publisher) with state, turns, activity, and a bounded rolling preview
 * of visible assistant text.
 *
 * All displayed child/repository text is treated as untrusted: ANSI/OSC/APC
 * sequences and control characters are stripped before theming, and every
 * rendered line is truncated to the terminal width.
 *
 * Live state is ephemeral — nothing here is written to the session.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ChildEvent } from "../shared/child-agent-runner.ts";
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

export interface TerminalText {
	stripTerminalSequences(text: string): string;
	truncateToWidth(text: string, width: number): string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
const ANSI_PATTERN =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
const OSC_PATTERN = /(?:\u001B[\]PX^_]|[\u0090\u0098\u009d-\u009f]).*?(?:\u0007|\u001B\\|\u009c|$)/gs;

export function stripTerminalSequencesFallback(input: string): string {
	return input.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}

export function codePointWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (cp >= 0x0300 && cp <= 0x036f) return 0;
	if (cp < 0x1100) return 1;
	return cp <= 0x115f ||
		cp === 0x2329 ||
		cp === 0x232a ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
		? 2
		: 1;
}

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
			return `${out}…`;
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

export interface DashboardRow {
	id: string;
	label: string;
	model: string;
	role: AgentRole;
	status: DashboardStatus;
	turns: number;
	activity?: string;
	/** Bounded rolling tail of visible assistant text. */
	preview?: string;
	error?: string;
	/** Epoch ms when the child started running. */
	startedAt?: number;
	/** Epoch ms when the child reached a terminal status. */
	finishedAt?: number;
}

export interface DashboardTheme {
	fg(color: string, text: string): string;
}

export function sanitizeDisplayText(input: string, text: TerminalText = fallbackTerminalText): string {
	const stripped = text.stripTerminalSequences(input);
	return (
		stripped
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
			.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
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

export class PlanImplementDashboardStore {
	private rows: DashboardRow[] = [];
	private listeners = new Set<() => void>();
	readonly startedAt: number;

	private readonly now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
		this.startedAt = now();
	}

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

	addPhase(id: string, label: string, model: string, role: AgentRole): void {
		const existing = this.find(id);
		if (existing) return;
		this.rows.push({ id, label, model, role, status: "queued", turns: 0 });
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
		row.preview = undefined;
		this.emit();
	}

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

export function renderDashboard(
	store: PlanImplementDashboardStore,
	width: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
): string[] {
	const lines: string[] = [];
	const summary = store.summary();
	const done = summary.completed + summary.failed + summary.aborted;
	const header =
		theme.fg("success", "■ Plan & implement") +
		theme.fg("muted", ` — ${done}/${summary.total} done · ${store.elapsedSeconds()}s`) +
		theme.fg("dim", " — ^⇧P inspect · ^⇧I abort");
	lines.push(text.truncateToWidth(header, width));

	const showModel = width >= 60;
	const showActivity = width >= 40;
	const showPreview = width >= 24;

	for (const row of store.getRows()) {
		const { icon, color } = STATUS_ICON[row.status];
		const safeLabel = sanitizeDisplayText(row.label, text);
		const safeModel = sanitizeDisplayText(row.model, text);
		let line = `${theme.fg(color, icon)} ${safeLabel}${theme.fg("muted", ` — ${row.status}`)}`;
		if (showModel) line += theme.fg("dim", ` (${safeModel})`);
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

export class PlanImplementDashboardComponent implements Component {
	private unsubscribe: (() => void) | undefined;

	private readonly store: PlanImplementDashboardStore;
	private readonly theme: DashboardTheme;
	private readonly text: TerminalText;

	constructor(
		store: PlanImplementDashboardStore,
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
		// Re-render happens via requestRender().
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

interface WidgetUi {
	setWidget(key: string, content: unknown): void;
}

export function mountPlanImplementDashboard(
	ui: WidgetUi,
	store: PlanImplementDashboardStore,
	text: TerminalText = fallbackTerminalText,
): () => void {
	let component: PlanImplementDashboardComponent | undefined;
	let disposed = false;
	ui.setWidget("plan-implement", (tui: RenderRequester, theme: DashboardTheme) => {
		component = new PlanImplementDashboardComponent(store, tui, theme, text);
		return component;
	});
	return () => {
		if (disposed) return;
		disposed = true;
		component?.dispose();
		component = undefined;
		ui.setWidget("plan-implement", undefined);
	};
}
