import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { buildSessionChoices } from "./session-choices.ts";
import type { SessionRow } from "./sessions.ts";

function timestamp(value: Date): string {
	return value.toISOString().replace("T", " ").slice(0, 16);
}

function optionLabel(row: SessionRow, label: string): string {
	return `[${row.kind}] ${label} — ${row.cwd}`;
}

function targetValue(row: SessionRow): string {
	if (row.kind === "active") return "archived";
	if (row.kind === "archived") return "active";
	return "details";
}

/** Forward picker input except Enter, which has no action in the sessions browser. */
export function handleSessionPickerInput(data: string, handleInput: ((data: string) => void) | undefined): void {
	if (matchesKey(data, Key.enter)) return;
	handleInput?.(data);
}

/** Pick exactly one session toggle. Space toggles while SettingsList preserves navigation and search. */
export async function selectSessionToggle(
	ctx: ExtensionCommandContext,
	rows: readonly SessionRow[],
): Promise<SessionRow | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/sessions requires TUI or RPC interactive selection.", "error");
		return undefined;
	}
	const byId = new Map(rows.map((row) => [row.id, row]));
	if (ctx.mode !== "tui") {
		const choices = buildSessionChoices([...rows]);
		const selected = await ctx.ui.select(
			"Toggle session archive status",
			choices.map(({ label, session }) => optionLabel(session, label)),
		);
		const choice = choices.find(({ label, session }) => optionLabel(session, label) === selected);
		return choice?.session;
	}
	return ctx.ui.custom<SessionRow | undefined>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Sessions")), 1, 0));
		const items: SettingItem[] = rows.map((row) => ({
			id: row.id,
			label: `${timestamp(row.modified)}  ${row.label} — ${row.cwd}${row.kind === "active" && row.current ? " (current)" : ""}`,
			currentValue: row.kind,
			values: [targetValue(row)],
		}));
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id) => {
				const row = byId.get(id);
				if (row) done(row);
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "Search · ↑↓ navigate · Space toggle/details · Esc cancel"), 1, 0));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => handleSessionPickerInput(data, list.handleInput?.bind(list)),
		};
	});
}
