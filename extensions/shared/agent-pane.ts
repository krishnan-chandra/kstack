import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChildEvent } from "./child-agent-runner.ts";
import { LiveDashboardStore, mountLiveDashboard } from "./live-dashboard.ts";
import { type OpenSubagentConsoleResult, openSubagentConsole } from "./subagent-console.ts";
import { ChildTranscriptStore } from "./transcript-store.ts";
import { type BoundaryValue, isFunction, isObject } from "./validation.ts";

const HOST_SYMBOL = Symbol.for("kstack.agent-pane-host");
const WIDGET_KEY = "kstack-agent-pane";
const VIEW_SHORTCUT = "ctrl+shift+v";
const ABORT_SHORTCUT = "ctrl+shift+x";

const terminalText = {
	stripTerminalSequences,
	truncateToWidth: (text: string, width: number) => truncateToWidth(text, width),
	visibleWidth,
};

interface AgentPaneRunOptions {
	ctx: ExtensionContext;
	title: string;
	emptyMessage?: string;
	clearPreviewOnComplete?: boolean;
	onAbort(): void;
}

interface AgentPaneChild {
	id: string;
	label: string;
	model: string;
	modelColor?: "accent" | "dim";
}

export interface AgentPaneRun {
	addChild(child: AgentPaneChild): void;
	markRunning(id: string): void;
	progress(id: string, info: { turns: number; activity?: string; preview?: string }): void;
	complete(id: string, info: { status: "completed" | "failed" | "aborted"; turns?: number; error?: string }): void;
	event(id: string, event: ChildEvent): void;
	note(id: string, text: string): void;
	dispose(): void;
}

class AgentPaneDashboardStore extends LiveDashboardStore {
	constructor(title: string, clearPreviewOnComplete: boolean) {
		super(`■ ${title}`, " — ^⇧V view · ^⇧X abort", clearPreviewOnComplete);
	}

	addChild(child: AgentPaneChild): void {
		this.addRow(child.id, child.label, child.model, child.modelColor ?? "dim", true);
	}
}

interface ActiveRun {
	ctx: ExtensionContext;
	title: string;
	emptyMessage: string;
	onAbort: () => void;
	dashboard: AgentPaneDashboardStore;
	transcripts: ChildTranscriptStore;
	console?: OpenSubagentConsoleResult;
	ticker: ReturnType<typeof setInterval>;
	disposed: boolean;
}

export interface AgentPaneHost {
	startRun(options: AgentPaneRunOptions): AgentPaneRun;
	resetSession(): void;
}

class AgentPaneHostImpl implements AgentPaneHost {
	private readonly runs: ActiveRun[] = [];
	private unmount: (() => void) | undefined;

	constructor(pi: ExtensionAPI) {
		pi.registerShortcut(VIEW_SHORTCUT, {
			description: "View active child agents",
			handler: async (ctx) => this.openActive(ctx),
		});
		pi.registerShortcut(ABORT_SHORTCUT, {
			description: "Abort active child agents",
			handler: async (ctx) => this.abortActive(ctx),
		});
		pi.on("session_shutdown", () => this.resetSession());
	}

	startRun(options: AgentPaneRunOptions): AgentPaneRun {
		this.closeConsole(this.active());
		const dashboard = new AgentPaneDashboardStore(options.title, options.clearPreviewOnComplete ?? true);
		const transcripts = new ChildTranscriptStore();
		const run: ActiveRun = {
			ctx: options.ctx,
			title: options.title,
			emptyMessage: options.emptyMessage ?? "No child agents active",
			onAbort: options.onAbort,
			dashboard,
			transcripts,
			ticker: setInterval(() => dashboard.tick(), 1000),
			disposed: false,
		};
		run.ticker.unref?.();
		this.runs.push(run);
		this.renderActive();

		return {
			addChild: (child) => {
				dashboard.addChild(child);
				transcripts.addChild(child.id);
			},
			markRunning: (id) => dashboard.markRunning(id),
			progress: (id, info) => dashboard.progress(id, { ...info, cost: transcripts.getTotalCost(id) }),
			complete: (id, info) => dashboard.complete(id, { ...info, cost: transcripts.getTotalCost(id) }),
			event: (id, event) => {
				transcripts.push(id, event);
				if (event.kind === "turn_end") {
					dashboard.updateCost(id, transcripts.getTotalCost(id));
				}
			},
			note: (id, text) => transcripts.note(id, text),
			dispose: () => this.disposeRun(run),
		};
	}

	resetSession(): void {
		this.unmount?.();
		this.unmount = undefined;
		for (const run of this.runs) {
			run.disposed = true;
			clearInterval(run.ticker);
			this.closeConsole(run);
			run.transcripts.dispose();
		}
		this.runs.length = 0;
	}

	private active(): ActiveRun | undefined {
		return this.runs.at(-1);
	}

	private openActive(ctx: ExtensionContext): void {
		const run = this.active();
		if (!run || run.disposed) {
			ctx.ui.notify("No child-agent pane is active.", "info");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The child-agent pane is available only in TUI mode.", "info");
			return;
		}
		if (run.console) return;
		const console = openSubagentConsole(ctx, run.dashboard, run.transcripts, {
			text: terminalText,
			onAbort: run.onAbort,
			copy: {
				title: run.title,
				emptyMessage: run.emptyMessage,
				helpSuffix: " · ^⇧X abort",
			},
			isAbortInput: (data) => {
				try {
					return matchesKey(data, "ctrl+shift+x");
				} catch {
					return false;
				}
			},
		});
		run.console = console;
		console.closed.finally(() => {
			if (run.console === console) run.console = undefined;
		});
	}

	private abortActive(ctx: ExtensionContext): void {
		const run = this.active();
		if (!run || run.disposed) {
			ctx.ui.notify("No child-agent pane is active.", "info");
			return;
		}
		run.onAbort();
	}

	private closeConsole(run: ActiveRun | undefined): void {
		run?.console?.close();
		if (run) run.console = undefined;
	}

	private disposeRun(run: ActiveRun): void {
		if (run.disposed) return;
		run.disposed = true;
		clearInterval(run.ticker);
		this.closeConsole(run);
		run.transcripts.dispose();
		const index = this.runs.indexOf(run);
		if (index >= 0) this.runs.splice(index, 1);
		this.renderActive();
	}

	private renderActive(): void {
		this.unmount?.();
		this.unmount = undefined;
		const run = this.active();
		if (run?.ctx.mode !== "tui") return;
		this.unmount = mountLiveDashboard(run.ctx.ui, WIDGET_KEY, run.dashboard, terminalText);
	}
}

function isAgentPaneHost(value: BoundaryValue): value is AgentPaneHost {
	return (
		isObject(value) &&
		value !== null &&
		"startRun" in value &&
		isFunction(value.startRun) &&
		"resetSession" in value &&
		isFunction(value.resetSession)
	);
}

/** Return the one pane host shared by every extension loaded on this Pi instance. */
export function getAgentPaneHost(pi: ExtensionAPI): AgentPaneHost {
	const existing: BoundaryValue = Object.getOwnPropertyDescriptor(pi, HOST_SYMBOL)?.value;
	if (isAgentPaneHost(existing)) return existing;
	const host = new AgentPaneHostImpl(pi);
	Object.defineProperty(pi, HOST_SYMBOL, { configurable: true, value: host });
	return host;
}
