/**
 * steering-swap: swap Enter and Alt+Enter while Pi is working.
 *
 * Pi's stock behavior while the agent is busy is Enter = steer and
 * Alt+Enter = queue a follow-up. This extension swaps those two keys inside
 * the main editor only, so Enter keeps its stock behavior everywhere else:
 * idle submission, inline prompts, selectors, and accepting autocomplete
 * completions.
 *
 * It replaces the main editor with a CustomEditor subclass whose handleInput
 * routes the configured submit key to Pi's native follow-up handler and the
 * configured follow-up key to Pi's native submit path (which steers while
 * streaming). Both routes reuse Pi's built-in code paths, so prompt history,
 * template expansion, and compaction queueing keep working.
 */
import {
	type AppKeybinding,
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

type SwapDecision = "queueFollowUp" | "steer" | "passthrough";

export function decideSwap(input: {
	busy: boolean;
	autocompleteOpen: boolean;
	matchesSubmit: boolean;
	matchesFollowUp: boolean;
}): SwapDecision {
	// Idle input and open autocomplete popups keep Pi's stock dispatch.
	if (!input.busy || input.autocompleteOpen) return "passthrough";
	// A key bound to both actions is ambiguous; let Pi's normal dispatch decide.
	if (input.matchesSubmit && input.matchesFollowUp) return "passthrough";
	if (input.matchesSubmit) return "queueFollowUp";
	if (input.matchesFollowUp) return "steer";
	return "passthrough";
}

/** The editor surface the swap needs; a subset of CustomEditor's public API. */
export interface SwapHost {
	disableSubmit: boolean;
	getText(): string;
	getExpandedText?(): string;
	setText(text: string): void;
	onSubmit?: (text: string) => void;
	actionHandlers: Map<AppKeybinding, () => void>;
}

/** Applies a swap decision. Returns true when the input was consumed. */
export function applySwap(host: SwapHost, decision: SwapDecision): boolean {
	if (decision === "queueFollowUp") {
		// Pi's native follow-up handler reads the editor itself and queues with
		// history, template expansion, and compaction handling.
		const handler = host.actionHandlers.get("app.message.followUp");
		if (!handler) return false;
		handler();
		return true;
	}
	if (decision === "steer") {
		// Pi's native submit path steers while streaming, with history,
		// template expansion, and compaction handling. Clearing the editor and
		// calling onSubmit mirrors Pi's own handleFollowUp idle fallback.
		if (host.disableSubmit) return true;
		const text = (host.getExpandedText?.() ?? host.getText()).trim();
		if (!text) return true;
		host.setText("");
		host.onSubmit?.(text);
		return true;
	}
	return false;
}

class SteeringSwapEditor extends CustomEditor {
	private readonly matcher: KeybindingsManager;
	private readonly isBusy: () => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, isBusy: () => boolean) {
		super(tui, theme, keybindings);
		this.matcher = keybindings;
		this.isBusy = isBusy;
	}

	override handleInput(data: string): void {
		const decision = decideSwap({
			busy: this.isBusy(),
			autocompleteOpen: this.isShowingAutocomplete(),
			matchesSubmit: this.matcher.matches(data, "tui.input.submit"),
			matchesFollowUp: this.matcher.matches(data, "app.message.followUp"),
		});
		if (applySwap(this, decision)) return;
		super.handleInput(data);
	}
}

export default function steeringSwap(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new SteeringSwapEditor(tui, theme, keybindings, () => !ctx.isIdle()),
		);
	});
}
