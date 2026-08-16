import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type KeybindingsManager,
	matchesKey,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SessionChoice, SessionChoiceSource } from "./session-choices.ts";
import { SessionSelectionModel, selectSessionChoicesWithDialogs } from "./session-selection.ts";

function sanitizeLabel(label: string): string {
	return stripTerminalSequences(label)
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize terminal control characters
			/[\x00-\x1f\x7f-\x9f]+/g,
			" ",
		)
		.replace(/\s+/g, " ")
		.trim();
}

class SessionMultiSelectComponent<T extends SessionChoiceSource> {
	readonly #model: SessionSelectionModel<T>;
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #keybindings: KeybindingsManager;
	readonly #done: (result: Array<SessionChoice<T>> | undefined) => void;
	readonly #maxVisible = 12;

	constructor(options: {
		choices: ReadonlyArray<SessionChoice<T>>;
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		done: (result: Array<SessionChoice<T>> | undefined) => void;
	}) {
		this.#model = new SessionSelectionModel(options.choices);
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#keybindings = options.keybindings;
		this.#done = options.done;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const selectedCount = this.#model.selectedCount;
		const start = Math.max(
			0,
			Math.min(
				this.#model.currentIndex - Math.floor(this.#maxVisible / 2),
				this.#model.choices.length - this.#maxVisible,
			),
		);
		const end = Math.min(start + this.#maxVisible, this.#model.choices.length);
		const lines = [
			truncateToWidth(this.#theme.fg("accent", this.#theme.bold("Archive inactive sessions")), safeWidth),
			"",
		];
		for (let index = start; index < end; index++) {
			const choice = this.#model.choices[index];
			if (!choice) continue;
			const focused = index === this.#model.currentIndex;
			const cursor = focused ? this.#theme.fg("accent", "›") : " ";
			const checkbox = this.#model.isSelected(choice)
				? this.#theme.fg("success", "[x]")
				: this.#theme.fg("muted", "[ ]");
			const safeLabel = sanitizeLabel(choice.label);
			const label = focused ? this.#theme.fg("accent", safeLabel) : safeLabel;
			lines.push(truncateToWidth(`${cursor} ${checkbox} ${label}`, safeWidth));
		}
		if (start > 0 || end < this.#model.choices.length) {
			lines.push(this.#theme.fg("dim", `  (${this.#model.currentIndex + 1}/${this.#model.choices.length})`));
		}
		const confirmHint =
			selectedCount === 0 ? "Enter archive focused session" : `Enter archive ${selectedCount} selected`;
		lines.push("", truncateToWidth(this.#theme.fg("dim", `Space toggle · ${confirmHint} · Esc cancel`), safeWidth));
		return lines;
	}

	handleInput(data: string): void {
		if (this.#keybindings.matches(data, "tui.select.up")) this.#model.move(-1);
		else if (this.#keybindings.matches(data, "tui.select.down")) this.#model.move(1);
		else if (this.#keybindings.matches(data, "tui.select.pageUp")) this.#model.movePage(-this.#maxVisible);
		else if (this.#keybindings.matches(data, "tui.select.pageDown")) this.#model.movePage(this.#maxVisible);
		else if (matchesKey(data, Key.space)) this.#model.toggleCurrent();
		else if (this.#keybindings.matches(data, "tui.select.confirm")) {
			this.#done(this.#model.confirmedChoices());
			return;
		} else if (this.#keybindings.matches(data, "tui.select.cancel")) {
			this.#done(undefined);
			return;
		} else return;
		this.#tui.requestRender();
	}

	invalidate(): void {}
}

/** Select any subset in one TUI dialog, with a repeated-dialog RPC fallback. */
export async function selectSessionChoices<T extends SessionChoiceSource>(
	ctx: ExtensionCommandContext,
	choices: ReadonlyArray<SessionChoice<T>>,
): Promise<Array<SessionChoice<T>> | undefined> {
	if (ctx.mode !== "tui") {
		return selectSessionChoicesWithDialogs(choices, (title, options) => ctx.ui.select(title, options));
	}
	return ctx.ui.custom<Array<SessionChoice<T>> | undefined>(
		(tui, theme, keybindings, done) => new SessionMultiSelectComponent({ choices, tui, theme, keybindings, done }),
	);
}
