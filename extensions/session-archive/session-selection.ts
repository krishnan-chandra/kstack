import type { SessionChoice, SessionChoiceSource } from "./session-choices.ts";

/** Mutable selection state kept independent from Pi so navigation and ordering are testable. */
export class SessionSelectionModel<T extends SessionChoiceSource> {
	readonly choices: ReadonlyArray<SessionChoice<T>>;
	currentIndex = 0;
	readonly #selected = new Set<SessionChoice<T>>();

	constructor(choices: ReadonlyArray<SessionChoice<T>>) {
		this.choices = choices;
	}

	move(delta: number): void {
		if (this.choices.length === 0) return;
		const next = (this.currentIndex + delta) % this.choices.length;
		this.currentIndex = next === 0 ? 0 : next < 0 ? next + this.choices.length : next;
	}

	movePage(delta: number): void {
		this.currentIndex = Math.max(0, Math.min(this.currentIndex + delta, this.choices.length - 1));
	}

	toggleCurrent(): void {
		const choice = this.choices[this.currentIndex];
		if (!choice) return;
		if (this.#selected.has(choice)) this.#selected.delete(choice);
		else this.#selected.add(choice);
	}

	isSelected(choice: SessionChoice<T>): boolean {
		return this.#selected.has(choice);
	}

	get selectedCount(): number {
		return this.#selected.size;
	}

	selectedChoices(): Array<SessionChoice<T>> {
		return this.choices.filter((choice) => this.isSelected(choice));
	}

	confirmedChoices(): Array<SessionChoice<T>> {
		const selected = this.selectedChoices();
		if (selected.length > 0) return selected;
		const focused = this.choices[this.currentIndex];
		return focused ? [focused] : [];
	}
}

type SelectDialog = (title: string, options: string[]) => Promise<string | undefined>;

/** RPC-compatible repeated picker; selected results retain the original listing order. */
export async function selectSessionChoicesWithDialogs<T extends SessionChoiceSource>(
	choices: ReadonlyArray<SessionChoice<T>>,
	select: SelectDialog,
): Promise<Array<SessionChoice<T>> | undefined> {
	const selected = new Set<SessionChoice<T>>();
	const remaining = [...choices];
	while (remaining.length > 0) {
		const selectedCount = selected.size;
		let finishLabel = `Archive selected (${selectedCount})`;
		while (choices.some((choice) => choice.label === finishLabel)) finishLabel = `✓ ${finishLabel}`;
		const options = remaining.map((choice) => choice.label);
		if (selectedCount > 0) options.push(finishLabel);
		const picked = await select("Select sessions to archive", options);
		if (!picked) return undefined;
		if (picked === finishLabel) return choices.filter((choice) => selected.has(choice));
		const index = remaining.findIndex((choice) => choice.label === picked);
		if (index < 0) return undefined;
		const choice = remaining[index];
		if (!choice) return undefined;
		remaining.splice(index, 1);
		selected.add(choice);
	}
	return choices.filter((choice) => selected.has(choice));
}
