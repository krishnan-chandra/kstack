import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DashboardStatus, DashboardTheme } from "./live-dashboard.ts";
import {
	type ConsoleScrollState,
	type ConsoleState,
	computeViewport,
	formatCost,
	formatElapsedSeconds,
	formatTokens,
	openSubagentConsole,
	renderSubagentConsole,
	SubagentConsoleComponent,
	sanitizeMultilineText,
	WIDE_MIN_WIDTH,
	wrapAndSanitizeText,
} from "./subagent-console.ts";
import { fallbackTerminalText, stripTerminalSequencesFallback, type TerminalText } from "./terminal-text.ts";
import type { TranscriptEntry } from "./transcript-store.ts";

const fakeTheme: DashboardTheme = {
	fg: (_color: string, text: string) => text,
};

const fakeText: TerminalText = {
	stripTerminalSequences: (t) =>
		t.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: test fixture strips terminal sequences
			/\x1b\[[0-9;]*[a-zA-Z]/g,
			"",
		),
	truncateToWidth: (t, w) => (t.length > w ? `${t.slice(0, Math.max(0, w - 1))}…` : t),
};

const COPY = { title: "Test console", emptyMessage: "Nothing running", helpSuffix: " · ^⇧X abort" };

interface FakeRow {
	id: string;
	label: string;
	model: string;
	status: DashboardStatus;
	turns: number;
	startedAt?: number;
	finishedAt?: number;
}

function makeRow(id: string, label: string, model: string, extra: Partial<FakeRow> = {}): FakeRow {
	return { id, label, model, status: "queued", turns: 0, ...extra };
}

function makeDashboard(rows: FakeRow[], options: { now?: number; elapsedSeconds?: number } = {}) {
	const listeners = new Set<() => void>();
	const now = options.now ?? 1000;
	const dashboard = {
		getRows: () => rows,
		nowMs: () => now,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: () => {
			for (const listener of listeners) listener();
		},
	};
	if (options.elapsedSeconds !== undefined) {
		const elapsed = options.elapsedSeconds;
		return { ...dashboard, elapsedSeconds: () => elapsed };
	}
	return dashboard;
}

function makeTranscripts() {
	const entries = new Map<string, TranscriptEntry[]>();
	const tails = new Map<string, string>();
	const evicted = new Set<string>();
	const totalCosts = new Map<string, number>();
	const listeners = new Set<() => void>();
	return {
		getEntries: (id: string) => entries.get(id) ?? [],
		getTotalCost: (id: string) =>
			totalCosts.get(id) ??
			(entries.get(id) ?? []).reduce((sum, entry) => sum + (entry.kind === "turn" ? entry.usage.cost : 0), 0),
		getLiveTail: (id: string) => tails.get(id),
		wasEvicted: (id: string) => evicted.has(id),
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		push: (id: string, entry: TranscriptEntry) => {
			const list = entries.get(id) ?? [];
			list.push(entry);
			entries.set(id, list);
			for (const listener of listeners) listener();
		},
		note: (id: string, text: string) => {
			const list = entries.get(id) ?? [];
			list.push({ kind: "note", text, at: 0 });
			entries.set(id, list);
			for (const listener of listeners) listener();
		},
		setTail: (id: string, tail: string) => {
			tails.set(id, tail);
			for (const listener of listeners) listener();
		},
		setEvicted: (id: string) => evicted.add(id),
		setTotalCost: (id: string, cost: number) => totalCosts.set(id, cost),
		emit: () => {
			for (const listener of listeners) listener();
		},
	};
}

function makeState(selectedIndex = 0, scroll: Map<string, ConsoleScrollState> = new Map()): ConsoleState {
	return { selectedIndex, scroll };
}

describe("key compatibility", () => {
	it("pins matchesKey support for legacy terminal sequences", () => {
		const sequences: Array<[string, Parameters<typeof matchesKey>[1]]> = [
			["\x1b", "escape"],
			["\x18", "ctrl+x"],
			["\x1b[D", "left"],
			["\x1b[Z", "shift+tab"],
			["\x1b[C", "right"],
			["\t", "tab"],
			["\x1b[A", "up"],
			["\x1b[B", "down"],
			["\x1b[5~", "pageUp"],
			["\x1b[6~", "pageDown"],
			["\x1b[H", "home"],
			["\x1b[F", "end"],
		];
		for (const [sequence, key] of sequences) assert.equal(matchesKey(sequence, key), true, key);
	});
});

describe("sanitizeMultilineText", () => {
	it("strips ANSI escapes and C0 controls while preserving newlines", () => {
		const hostile = "\x1b[31mRed\x1b[0m\nLine\x00Two\r\nLine\x07Three";
		const clean = sanitizeMultilineText(hostile, fakeText);
		assert.equal(clean, "Red\nLine Two\nLine Three");
	});

	it("strips OSC sequences with the fallback stripper", () => {
		const hostile = "before\x1b]8;;https://evil.example\x07link\x1b]8;;\x07after";
		const clean = sanitizeMultilineText(hostile, {
			stripTerminalSequences: stripTerminalSequencesFallback,
			truncateToWidth: (t, w) => t.slice(0, w),
		});
		assert.equal(clean, "beforelinkafter");
	});
});

describe("wrapAndSanitizeText", () => {
	it("wraps lines exceeding width at word boundaries", () => {
		const text = "hello brave new world of coding agents";
		const wrapped = wrapAndSanitizeText(text, 15, fakeText);
		for (const line of wrapped) {
			assert.ok(line.length <= 15, `Line too long: ${line}`);
		}
		assert.equal(wrapped.join(" "), text);
	});

	it("wraps wide characters by display width, not code-unit length", () => {
		// 6 CJK chars = 12 display cells; must wrap at width 10 into 5+1 chars.
		const wrapped = wrapAndSanitizeText("漢字漢字漢字", 10, fallbackTerminalText);
		assert.deepEqual(wrapped, ["漢字漢字漢", "字"]);
	});

	it("never splits before a wide char that would overflow the cell budget", () => {
		const wrapped = wrapAndSanitizeText("ab 漢字 cd", 4, fallbackTerminalText);
		for (const line of wrapped) {
			assert.ok((fallbackTerminalText.visibleWidth ?? (() => 0))(line) <= 4, `overflow: ${line}`);
		}
		assert.equal(wrapped.join(" ").replace(/\s+/g, " ").trim(), "ab 漢字 cd");
	});

	it("preserves extended grapheme clusters while wrapping", () => {
		const terminalText: TerminalText = {
			stripTerminalSequences,
			truncateToWidth: (text, width) => truncateToWidth(text, width),
			visibleWidth,
		};
		assert.deepEqual(wrapAndSanitizeText("aa 👨‍👩‍👧‍👦 bb", 4, terminalText), ["aa", "👨‍👩‍👧‍👦", "bb"]);
	});
});

describe("format helpers", () => {
	it("formats small and large token counts", () => {
		assert.equal(formatTokens(800), "800");
		assert.equal(formatTokens(12400), "12.4k");
		assert.equal(formatTokens(50000), "50k");
	});

	it("formats costs with precision for tiny amounts", () => {
		assert.equal(formatCost(0.012), "$0.012");
		assert.equal(formatCost(0.0012), "$0.0012");
	});

	it("formats elapsed seconds compactly", () => {
		assert.equal(formatElapsedSeconds(45), "45s");
		assert.equal(formatElapsedSeconds(192), "3m12s");
		assert.equal(formatElapsedSeconds(3725), "1h02m");
	});
});

describe("computeViewport", () => {
	it("uses the wide layout at and above the breakpoint", () => {
		const viewport = computeViewport(WIDE_MIN_WIDTH, 20);
		assert.equal(viewport.wide, true);
		assert.equal(viewport.bodyHeight, 17);
		assert.ok(viewport.sidebarWidth > 0);
		assert.equal(viewport.transcriptWidth, WIDE_MIN_WIDTH - viewport.sidebarWidth - 3);
	});

	it("uses the narrow layout below the breakpoint", () => {
		const viewport = computeViewport(WIDE_MIN_WIDTH - 1, 20);
		assert.equal(viewport.wide, false);
		assert.equal(viewport.bodyHeight, 17);
		assert.equal(viewport.sidebarWidth, 0);
		assert.equal(viewport.transcriptWidth, WIDE_MIN_WIDTH - 1);
	});
});

describe("renderSubagentConsole narrow layout", () => {
	it("renders tab bar, meta line, transcript entries, and help text", () => {
		const dashboard = makeDashboard(
			[makeRow("r1", "alpha", "model-a", { status: "running" }), makeRow("r2", "beta", "model-b")],
			{ now: 2000 },
		);
		const transcripts = makeTranscripts();
		transcripts.note("r1", "alpha started");
		transcripts.push("r1", { kind: "tool", summary: "read foo.ts", durationMs: 340, at: 1340 });
		transcripts.push("r1", {
			kind: "turn",
			turn: 1,
			usage: { input: 12400, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.012, turns: 1 },
			at: 2000,
		});
		transcripts.push("r1", { kind: "text", text: "I inspected foo.ts.", turn: 1, at: 2100 });

		const lines = renderSubagentConsole(dashboard, transcripts, makeState(), 80, 20, fakeTheme, fakeText, COPY);

		assert.equal(lines.length, 20);
		assert.match(lines[0], /alpha.*beta/);
		assert.match(lines[1], /model-a.*running/);
		assert.match(lines[1], /\$0\.012/);
		const joined = lines.join("\n");
		assert.match(joined, /alpha started/);
		assert.match(joined, /read foo\.ts · 340ms/);
		assert.match(joined, /— turn 1 · in 12\.4k out 800 · \$0\.012/);
		assert.match(joined, /I inspected foo\.ts\./);
		assert.match(lines[19], /←→\/tab child/);
		assert.match(lines[19], /follow \[ON\]/);
		assert.match(lines[19], /\^⇧X abort/);
	});

	it("displays the eviction notice when entries were dropped", () => {
		const dashboard = makeDashboard([makeRow("r1", "alpha", "model-a")]);
		const transcripts = makeTranscripts();
		transcripts.setEvicted("r1");
		for (let i = 1; i <= 30; i++) transcripts.note("r1", `Line ${i}`);

		const scroll = new Map([["r1", { scrollOffset: 29, follow: false }]]);
		const lines = renderSubagentConsole(
			dashboard,
			transcripts,
			makeState(0, scroll),
			80,
			10,
			fakeTheme,
			fakeText,
			COPY,
		);
		assert.match(lines.join("\n"), /earlier transcript dropped/);
	});

	it("never exceeds terminal width even on narrow viewports", () => {
		const dashboard = makeDashboard([
			makeRow("r1", "very-long-reviewer-label-for-testing", "super-long-provider/model-name-extraordinaire"),
		]);
		const transcripts = makeTranscripts();
		transcripts.note("r1", "A very long lifecycle note that should wrap or truncate properly without breaking.");

		const lines = renderSubagentConsole(dashboard, transcripts, makeState(), 35, 12, fakeTheme, fakeText, COPY);
		assert.equal(lines.length, 12);
		for (const line of lines) {
			assert.ok(line.length <= 35, `Line exceeded narrow width 35: "${line}" (${line.length})`);
		}
	});

	it("supports scrolling up away from tail and follow mode", () => {
		const dashboard = makeDashboard([makeRow("r1", "alpha", "model-a")]);
		const transcripts = makeTranscripts();
		for (let i = 1; i <= 30; i++) transcripts.note("r1", `Line ${i}`);

		const followLines = renderSubagentConsole(dashboard, transcripts, makeState(), 80, 10, fakeTheme, fakeText, COPY);
		assert.ok(followLines.some((l) => l.includes("Line 30")));
		assert.ok(!followLines.some((l) => l.includes("Line 1")));

		const scrolled = new Map([["r1", { scrollOffset: 25, follow: false }]]);
		const scrolledLines = renderSubagentConsole(
			dashboard,
			transcripts,
			makeState(0, scrolled),
			80,
			10,
			fakeTheme,
			fakeText,
			COPY,
		);
		assert.ok(scrolledLines.some((l) => l.includes("Line 1")));
	});

	it("renders the empty message when no children exist", () => {
		const dashboard = makeDashboard([]);
		const transcripts = makeTranscripts();
		const lines = renderSubagentConsole(dashboard, transcripts, makeState(), 80, 20, fakeTheme, fakeText, COPY);
		assert.deepEqual(lines, ["Nothing running"]);
	});
});

describe("renderSubagentConsole wide layout", () => {
	const width = 120;
	const height = 20;

	function wideSetup(childCount: number) {
		const rows: FakeRow[] = [];
		for (let i = 1; i <= childCount; i++) {
			rows.push(makeRow(`r${i}`, `child-${i}`, `model-${i}`, { status: "running", startedAt: 1000 }));
		}
		const dashboard = makeDashboard(rows, { now: 5000, elapsedSeconds: 192 });
		const transcripts = makeTranscripts();
		for (let i = 1; i <= childCount; i++) {
			transcripts.push(`r${i}`, {
				kind: "turn",
				turn: 1,
				usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
				at: 2000,
			});
			transcripts.note(`r${i}`, `transcript of child ${i}`);
		}
		return { dashboard, transcripts };
	}

	it("renders a bordered title bar, sidebar, transcript pane, and help line", () => {
		const { dashboard, transcripts } = wideSetup(3);
		const lines = renderSubagentConsole(dashboard, transcripts, makeState(), width, height, fakeTheme, fakeText, COPY);

		assert.equal(lines.length, height);
		// Title bar
		assert.ok(lines[0].startsWith("┌"), lines[0]);
		assert.ok(lines[0].endsWith("┐"), lines[0]);
		assert.match(lines[0], /Test console/);
		assert.match(lines[0], /3m12s/);
		assert.match(lines[0], /\$0\.030/);
		// Bottom border
		assert.ok(lines[height - 1].startsWith("└"));
		assert.ok(lines[height - 1].endsWith("┘"));
		// Help line inside the border, second to last
		assert.match(lines[height - 2], /follow \[ON\]/);
		assert.ok(lines[height - 2].startsWith("│"));
		assert.ok(lines[height - 2].endsWith("│"));
		// Sidebar shows every child label, selected child's transcript in the pane
		const joined = lines.join("\n");
		assert.match(joined, /child-1/);
		assert.match(joined, /child-2/);
		assert.match(joined, /child-3/);
		assert.match(joined, /model-1/);
		assert.match(joined, /transcript of child 1/);
		// Every body row is bordered
		for (let i = 1; i < height - 1; i++) {
			assert.ok(lines[i].startsWith("│"), `row ${i}: ${lines[i]}`);
			assert.ok(lines[i].endsWith("│"), `row ${i}: ${lines[i]}`);
		}
	});

	it("keeps every line within the terminal width", () => {
		const { dashboard, transcripts } = wideSetup(4);
		transcripts.note("r1", "A".repeat(500));
		const lines = renderSubagentConsole(
			dashboard,
			transcripts,
			makeState(),
			WIDE_MIN_WIDTH,
			15,
			fakeTheme,
			fallbackTerminalText,
			COPY,
		);
		const measure = fallbackTerminalText.visibleWidth ?? (() => 0);
		for (const line of lines) {
			assert.ok(measure(line) <= WIDE_MIN_WIDTH, `overflow (${measure(line)}): ${line}`);
		}
	});

	it("keeps ≥4 children fully labeled in the sidebar", () => {
		const { dashboard, transcripts } = wideSetup(6);
		const lines = renderSubagentConsole(dashboard, transcripts, makeState(), width, height, fakeTheme, fakeText, COPY);
		const joined = lines.join("\n");
		for (let i = 1; i <= 6; i++) {
			assert.match(joined, new RegExp(`child-${i}`));
		}
	});

	it("windows the sidebar so the selected child stays visible", () => {
		const { dashboard, transcripts } = wideSetup(12);
		// bodyHeight = 10 → only 5 children fit; select the last one.
		const lines = renderSubagentConsole(dashboard, transcripts, makeState(11), width, 13, fakeTheme, fakeText, COPY);
		const joined = lines.join("\n");
		assert.match(joined, /child-12/);
		assert.ok(!joined.includes("child-1 "), `early children should be windowed out:\n${joined}`);
	});

	it("keeps the selected child's label visible on a one-row body", () => {
		const { dashboard, transcripts } = wideSetup(3);
		// height 4 → bodyHeight 1: only one sidebar line fits.
		const lines = renderSubagentConsole(dashboard, transcripts, makeState(2), width, 4, fakeTheme, fakeText, COPY);
		assert.equal(lines.length, 4);
		assert.match(lines[1], /child-3/);
	});

	it("sums cost across all children in the title and follows the selected child", () => {
		const { dashboard, transcripts } = wideSetup(2);
		const lines = renderSubagentConsole(dashboard, transcripts, makeState(1), width, height, fakeTheme, fakeText, COPY);
		assert.match(lines[0], /\$0\.020/);
		assert.match(lines.join("\n"), /transcript of child 2/);
		assert.ok(!lines.join("\n").includes("transcript of child 1"));
	});

	it("uses cumulative cost even when older turn entries were evicted", () => {
		const { dashboard, transcripts } = wideSetup(1);
		transcripts.setTotalCost("r1", 0.25);
		const lines = renderSubagentConsole(dashboard, transcripts, makeState(), width, height, fakeTheme, fakeText, COPY);
		assert.match(lines[0], /\$0\.250/);
	});

	it("produces exactly `height` lines at several sizes", () => {
		const { dashboard, transcripts } = wideSetup(1);
		for (const [w, h] of [
			[100, 10],
			[120, 20],
			[200, 40],
		]) {
			const lines = renderSubagentConsole(dashboard, transcripts, makeState(), w, h, fakeTheme, fakeText, COPY);
			assert.equal(lines.length, h, `${w}x${h}`);
		}
	});
});

describe("SubagentConsoleComponent", () => {
	function setup(options: { rows?: number; notes?: number } = {}) {
		const dashboard = makeDashboard(
			[makeRow("r1", "alpha", "model-a", { status: "running" }), makeRow("r2", "beta", "model-b")],
			{ now: 2000 },
		);
		const transcripts = makeTranscripts();
		for (let i = 1; i <= (options.notes ?? 30); i++) transcripts.note("r1", `Note ${i}`);
		transcripts.note("r2", "beta note");
		const flags = { closed: false, aborted: false, renders: 0 };
		const tui = {
			requestRender: () => {
				flags.renders++;
			},
			terminal: { rows: options.rows ?? 25 },
		};
		const component = new SubagentConsoleComponent(
			dashboard,
			transcripts,
			tui,
			fakeTheme,
			() => {
				flags.closed = true;
			},
			() => {
				flags.aborted = true;
			},
			fakeText,
			COPY,
		);
		return { dashboard, transcripts, flags, component };
	}

	it("handles keyboard input for tabs, scrolling, follow, and escape", () => {
		const { component, flags } = setup();
		assert.equal(component.getState().selectedIndex, 0);

		component.handleInput("\x1b[C");
		assert.equal(component.getState().selectedIndex, 1);
		component.handleInput("\x1b[D");
		assert.equal(component.getState().selectedIndex, 0);

		component.handleInput("\x1b[A");
		assert.equal(component.getState().scroll.get("r1")?.scrollOffset, 1);
		assert.equal(component.getState().scroll.get("r1")?.follow, false);

		component.handleInput("f");
		assert.equal(component.getState().scroll.get("r1")?.follow, true);
		assert.equal(component.getState().scroll.get("r1")?.scrollOffset, 0);

		component.handleInput("\x18"); // plain Ctrl+X is not an abort shortcut
		assert.equal(flags.aborted, false);

		component.handleInput("\x1b");
		assert.equal(flags.closed, true);
		component.dispose();
	});

	it("passes ctrl+shift abort keys through to onAbort and ignores unknown sequences", () => {
		const { component, flags } = setup();
		const before = component.getState().selectedIndex;
		assert.doesNotThrow(() => component.handleInput("\x1b[999~"));
		assert.equal(component.getState().selectedIndex, before);
		component.handleInput("\x1b[120;6u"); // ctrl+shift+x
		assert.equal(flags.aborted, true);
		component.handleInput("\x1b[105;6u"); // ctrl+shift+i
		component.dispose();
	});

	it("clamps scrollOffset on home/g and allows immediate downward scrolling", () => {
		const { component } = setup({ rows: 20, notes: 50 });
		component.render(80);

		component.handleInput("g");
		const topOffset = component.getState().scroll.get("r1")?.scrollOffset ?? -1;
		assert.ok(topOffset > 0 && topOffset < 100, `topOffset was ${topOffset}`);
		assert.equal(component.getState().scroll.get("r1")?.follow, false);

		component.handleInput("\x1b[B");
		assert.equal(component.getState().scroll.get("r1")?.scrollOffset, topOffset - 1);

		component.handleInput("G");
		assert.equal(component.getState().scroll.get("r1")?.scrollOffset, 0);
		assert.equal(component.getState().scroll.get("r1")?.follow, true);
		component.dispose();
	});

	it("keeps the visible viewport anchored while new output arrives with follow off", () => {
		const { component, transcripts } = setup({ rows: 10, notes: 20 });
		component.render(80);
		for (let i = 0; i < 5; i++) component.handleInput("\x1b[A");

		const before = component.render(80).slice(2, -1).filter(Boolean);
		transcripts.note("r1", "Note 21");
		const after = component.render(80).slice(2, -1).filter(Boolean);
		assert.deepEqual(after, before);
		component.dispose();
	});

	it("remembers and anchors scroll position per child across tab switches", () => {
		const { component, transcripts } = setup({ rows: 20, notes: 50 });
		component.render(80);

		// Scroll child r1 up by 5
		for (let i = 0; i < 5; i++) component.handleInput("\x1b[A");
		assert.equal(component.getState().scroll.get("r1")?.scrollOffset, 5);
		const before = component.render(80).slice(2, -1).filter(Boolean);

		// Switch to r2: fresh child starts at the tail in follow mode
		component.handleInput("\x1b[C");
		assert.equal(component.getState().selectedIndex, 1);
		assert.equal(component.getState().scroll.get("r2")?.follow, true);
		assert.equal(component.getState().scroll.get("r2")?.scrollOffset, 0);

		// New output for an inactive child is anchored when it is selected again.
		transcripts.note("r1", "Note 51");
		component.handleInput("\x1b[D");
		assert.equal(component.getState().selectedIndex, 0);
		assert.equal(component.getState().scroll.get("r1")?.scrollOffset, 6);
		assert.equal(component.getState().scroll.get("r1")?.follow, false);
		assert.deepEqual(component.render(80).slice(2, -1).filter(Boolean), before);
		component.dispose();
	});

	it("requests renders when stores emit", () => {
		const { dashboard, transcripts, component, flags } = setup();
		const before = flags.renders;
		dashboard.emit();
		transcripts.emit();
		assert.equal(flags.renders, before + 2);
		component.dispose();
		dashboard.emit();
		assert.equal(flags.renders, before + 2);
	});

	it("renders at the full terminal height with no 0.8 guess", () => {
		const { component } = setup({ rows: 31 });
		const lines = component.render(80);
		assert.equal(lines.length, 31);
		component.dispose();
	});
});

describe("openSubagentConsole", () => {
	it("opens a full-screen overlay and resolves when closed", async () => {
		const dashboard = makeDashboard([makeRow("r1", "alpha", "model-a")]);
		const transcripts = makeTranscripts();

		let customOptions: unknown;
		const ctx = {
			ui: {
				custom: async (_factory: unknown, options: unknown) => {
					customOptions = options;
				},
			},
		};

		const result = openSubagentConsole(ctx as never, dashboard, transcripts, { text: fakeText, copy: COPY });
		assert.deepEqual(customOptions, {
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
		});
		result.close();
		await result.closed;
	});
});
