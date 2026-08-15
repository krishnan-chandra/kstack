import type { Component } from "@earendil-works/pi-tui";
import { fallbackTerminalText, sanitizeDisplayText, type TerminalText } from "./terminal-text.ts";

export type DashboardStatus = "queued" | "running" | "completed" | "failed" | "aborted";

interface DashboardRow {
	id: string;
	label: string;
	model: string;
	modelColor: "accent" | "dim";
	status: DashboardStatus;
	turns: number;
	activity?: string;
	preview?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
}

export interface DashboardTheme {
	fg(color: string, text: string): string;
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
	return Math.max(0, Math.round(((row.finishedAt ?? now) - row.startedAt) / 1000));
}

export class LiveDashboardStore {
	private rows: DashboardRow[] = [];
	private listeners = new Set<() => void>();
	private readonly clearPreviewOnComplete: boolean;
	private readonly now: () => number;
	readonly title: string;
	readonly help: string;
	readonly startedAt: number;

	constructor(title: string, help: string, clearPreviewOnComplete: boolean, now: () => number = () => Date.now()) {
		this.title = title;
		this.help = help;
		this.clearPreviewOnComplete = clearPreviewOnComplete;
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
		return this.rows.find((row) => row.id === id);
	}

	protected addRow(id: string, label: string, model: string, modelColor: "accent" | "dim", deduplicate: boolean): void {
		if (deduplicate && this.find(id)) return;
		this.rows.push({ id, label, model, modelColor, status: "queued", turns: 0 });
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
		if (this.clearPreviewOnComplete) row.preview = undefined;
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
	store: LiveDashboardStore,
	width: number,
	theme: DashboardTheme,
	text: TerminalText = fallbackTerminalText,
): string[] {
	const lines: string[] = [];
	const summary = store.summary();
	const done = summary.completed + summary.failed + summary.aborted;
	const header =
		theme.fg("success", store.title) +
		theme.fg("muted", ` — ${done}/${summary.total} done · ${store.elapsedSeconds()}s`) +
		theme.fg("dim", store.help);
	lines.push(text.truncateToWidth(header, width));

	const showModel = width >= 60;
	const showActivity = width >= 40;
	const showPreview = width >= 24;
	for (const row of store.getRows()) {
		const { icon, color } = STATUS_ICON[row.status];
		const safeLabel = sanitizeDisplayText(row.label, text);
		const safeModel = sanitizeDisplayText(row.model, text);
		let line = `${theme.fg(color, icon)} ${safeLabel}${theme.fg("muted", ` — ${row.status}`)}`;
		if (showModel) line += theme.fg(row.modelColor, ` (${safeModel})`);
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
			if (preview) lines.push(text.truncateToWidth(`  ${theme.fg("muted", "›")} ${theme.fg("dim", preview)}`, width));
		}
	}
	return lines;
}

export interface RenderRequester {
	requestRender(): void;
}

export class LiveDashboardComponent implements Component {
	private unsubscribe: (() => void) | undefined;
	private readonly store: LiveDashboardStore;
	private readonly theme: DashboardTheme;
	private readonly text: TerminalText;

	constructor(
		store: LiveDashboardStore,
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

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

interface WidgetUi {
	setWidget(key: string, content: unknown): void;
}

export function mountLiveDashboard(
	ui: WidgetUi,
	key: string,
	store: LiveDashboardStore,
	text: TerminalText = fallbackTerminalText,
): () => void {
	let component: LiveDashboardComponent | undefined;
	let disposed = false;
	ui.setWidget(key, (tui: RenderRequester, theme: DashboardTheme) => {
		component = new LiveDashboardComponent(store, tui, theme, text);
		return component;
	});
	return () => {
		if (disposed) return;
		disposed = true;
		component?.dispose();
		component = undefined;
		ui.setWidget(key, undefined);
	};
}
