import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { SessionRow } from "./sessions.ts";

interface SessionToggle {
	id: string;
	kind: "active" | "archived";
	current: boolean;
}

function timestamp(value: Date): string {
	return value.toISOString().replace("T", " ").slice(0, 16);
}

/** Pick exactly one session toggle. SettingsList keeps navigation and search consistent with Pi. */
export async function selectSessionToggle(
	ctx: ExtensionCommandContext,
	rows: readonly SessionRow[],
): Promise<SessionToggle | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/sessions requires TUI or RPC interactive selection.", "error");
		return undefined;
	}
	const byId = new Map(rows.map((row) => [row.id, row]));
	if (ctx.mode !== "tui") {
		const selected = await ctx.ui.select(
			"Toggle session archive status",
			rows.map((row) => `[${row.kind}] ${row.label} — ${row.cwd}`),
		);
		const row = rows.find((candidate) => `[${candidate.kind}] ${candidate.label} — ${candidate.cwd}` === selected);
		return row ? { id: row.id, kind: row.kind, current: row.kind === "active" && row.current } : undefined;
	}
	return ctx.ui.custom<SessionToggle | undefined>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Sessions — Enter toggles archive status")), 1, 0));
		const items: SettingItem[] = rows.map((row) => ({
			id: row.id,
			label: `${timestamp(row.modified)}  ${row.label}${row.kind === "active" && row.current ? " (current)" : ""}`,
			currentValue: row.kind,
			values: [row.kind === "active" ? "archived" : "active"],
		}));
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id) => {
				const row = byId.get(id);
				if (row) done({ id: row.id, kind: row.kind, current: row.kind === "active" && row.current });
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "Search · ↑↓ navigate · Enter archive/restore · Esc cancel"), 1, 0));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => list.handleInput?.(data),
		};
	});
}
