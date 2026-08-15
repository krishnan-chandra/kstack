import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import type { DashboardTheme } from "../shared/live-dashboard.ts";
import type { TerminalText } from "../shared/terminal-text.ts";
import {
	formatTokens,
	InspectorComponent,
	type InspectorState,
	renderInspector,
	sanitizeMultilineText,
	wrapAndSanitizeText,
} from "./inspector-overlay.ts";
import { PanelDashboardStore } from "./live-dashboard.ts";
import { PanelTranscriptStore } from "./transcript-store.ts";

const fakeTheme: DashboardTheme = {
	fg: (_color: string, text: string) => text,
};

const fakeText: TerminalText = {
	stripTerminalSequences: (t) => t.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""),
	truncateToWidth: (t, w) => (t.length > w ? `${t.slice(0, Math.max(0, w - 1))}…` : t),
};

describe("inspector key compatibility", () => {
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
});

describe("formatTokens", () => {
	it("formats small and large token counts", () => {
		assert.equal(formatTokens(800), "800");
		assert.equal(formatTokens(12400), "12.4k");
		assert.equal(formatTokens(50000), "50k");
	});
});

describe("renderInspector", () => {
	it("renders tab bar with selected reviewer highlighted", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "anthropic/claude-3-7-sonnet");
		dashboard.addReviewer("r2", "beta", "openai/gpt-4o");

		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		transcripts.addChild("r2");

		const state: InspectorState = { selectedIndex: 0, scrollOffset: 0, follow: true };
		const lines = renderInspector(dashboard, transcripts, state, 80, 15, fakeTheme, fakeText);

		assert.ok(lines.length <= 15);
		assert.match(lines[0], /alpha.*beta/);
		assert.match(lines[1], /claude-3-7-sonnet.*queued/);
		assert.match(lines[lines.length - 1], /follow \[ON\]/);
	});

	it("renders tool calls with durations and turn usage markers", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "model-a");
		dashboard.markRunning("r1");

		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		transcripts.push("r1", { kind: "tool_start", summary: "read foo.ts", at: 1000 });
		transcripts.push("r1", { kind: "tool_end", durationMs: 340, at: 1340 });
		transcripts.push("r1", {
			kind: "turn_end",
			turn: 1,
			text: "I inspected foo.ts and found no issues.",
			usage: { input: 12400, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.012, turns: 1 },
			at: 2000,
		});

		const state: InspectorState = { selectedIndex: 0, scrollOffset: 0, follow: true };
		const lines = renderInspector(dashboard, transcripts, state, 80, 15, fakeTheme, fakeText);

		const joined = lines.join("\n");
		assert.match(joined, /read foo\.ts · 340ms/);
		assert.match(joined, /— turn 1 · in 12\.4k out 800 · \$0\.012/);
		assert.match(joined, /I inspected foo\.ts and found no issues\./);
	});

	it("displays eviction notice when entries are evicted", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "model-a");

		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		for (let i = 0; i < 1005; i++) {
			transcripts.push("r1", { kind: "tool_start", summary: `tool-${i}`, at: i });
		}

		// When scrolled to the top, the eviction notice is visible as the first entry
		const state: InspectorState = { selectedIndex: 0, scrollOffset: 1000, follow: false };
		const lines = renderInspector(dashboard, transcripts, state, 80, 15, fakeTheme, fakeText);

		const joined = lines.join("\n");
		assert.match(joined, /earlier transcript dropped/);
	});

	it("never exceeds terminal width even on narrow viewports", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer(
			"r1",
			"very-long-reviewer-label-for-testing",
			"super-long-provider/model-name-extraordinaire",
		);

		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		transcripts.note("r1", "A very long lifecycle note that should wrap or truncate properly without breaking.");

		const state: InspectorState = { selectedIndex: 0, scrollOffset: 0, follow: true };
		const narrowWidth = 35;
		const lines = renderInspector(dashboard, transcripts, state, narrowWidth, 12, fakeTheme, fakeText);

		for (const line of lines) {
			assert.ok(line.length <= narrowWidth, `Line exceeded narrow width ${narrowWidth}: "${line}" (${line.length})`);
		}
	});

	it("supports scrolling up away from tail and follow mode", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "model-a");

		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		for (let i = 1; i <= 30; i++) {
			transcripts.note("r1", `Line ${i}`);
		}

		// Follow tail (default) shows the latest lines
		const followState: InspectorState = { selectedIndex: 0, scrollOffset: 0, follow: true };
		const followLines = renderInspector(dashboard, transcripts, followState, 80, 10, fakeTheme, fakeText);
		assert.ok(followLines.some((l) => l.includes("Line 30")));
		assert.ok(!followLines.some((l) => l.includes("Line 1")));

		// Scrolled up shows earlier lines
		const scrolledState: InspectorState = { selectedIndex: 0, scrollOffset: 25, follow: false };
		const scrolledLines = renderInspector(dashboard, transcripts, scrolledState, 80, 10, fakeTheme, fakeText);
		assert.ok(scrolledLines.some((l) => l.includes("Line 1")));
	});
});

describe("InspectorComponent", () => {
	it("handles keyboard input for tabs, scrolling, follow, and escape", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "model-a");
		dashboard.addReviewer("r2", "beta", "model-b");

		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		transcripts.addChild("r2");
		for (let i = 1; i <= 30; i++) {
			transcripts.note("r1", `Note ${i}`);
		}

		let closed = false;
		let aborted = false;
		let _renders = 0;
		const fakeTui = {
			requestRender: () => {
				_renders++;
			},
			terminal: { rows: 25 },
		};

		const comp = new InspectorComponent(
			dashboard,
			transcripts,
			fakeTui,
			fakeTheme,
			() => {
				closed = true;
			},
			() => {
				aborted = true;
			},
			fakeText,
		);

		assert.equal(comp.getState().selectedIndex, 0);
		assert.equal(comp.getState().follow, true);

		// Switch tab (right)
		comp.handleInput("\x1b[C");
		assert.equal(comp.getState().selectedIndex, 1);

		// Switch tab (left)
		comp.handleInput("\x1b[D");
		assert.equal(comp.getState().selectedIndex, 0);

		// Scroll up (disables follow)
		comp.handleInput("\x1b[A");
		assert.equal(comp.getState().scrollOffset, 1);
		assert.equal(comp.getState().follow, false);

		// Toggle follow
		comp.handleInput("f");
		assert.equal(comp.getState().follow, true);
		assert.equal(comp.getState().scrollOffset, 0);

		// Plain Ctrl+X is not an abort shortcut.
		comp.handleInput("\x18");
		assert.equal(aborted, false);

		// Escape
		comp.handleInput("\x1b");
		assert.equal(closed, true);

		comp.dispose();
	});

	it("handles ctrl-shift-x and ignores unknown sequences", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "model-a");
		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		let aborted = false;
		const comp = new InspectorComponent(
			dashboard,
			transcripts,
			{ requestRender: () => {} },
			fakeTheme,
			() => {},
			() => {
				aborted = true;
			},
			fakeText,
		);
		const before = { ...comp.getState() };
		assert.doesNotThrow(() => comp.handleInput("\x1b[999~"));
		assert.deepEqual(comp.getState(), before);
		comp.handleInput("\x1b[120;6u");
		assert.equal(aborted, true);
		comp.dispose();
	});

	it("clamps scrollOffset on home/g and allows immediate downward scrolling", () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "model-a");

		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");
		for (let i = 1; i <= 50; i++) {
			transcripts.note("r1", `Line ${i}`);
		}

		const fakeTui = {
			requestRender: () => {},
			terminal: { rows: 20 }, // available body height = 13 (20*0.8=16; 16-3=13)
		};

		const comp = new InspectorComponent(
			dashboard,
			transcripts,
			fakeTui,
			fakeTheme,
			() => {},
			() => {},
			fakeText,
		);

		comp.render(80);

		// Jump to top via 'g'
		comp.handleInput("g");
		const topOffset = comp.getState().scrollOffset;
		assert.ok(topOffset > 0 && topOffset < 100, `topOffset was ${topOffset}`);
		assert.equal(comp.getState().follow, false);

		// Immediately press down: should decrement from topOffset, not 999999
		comp.handleInput("\x1b[B");
		assert.equal(comp.getState().scrollOffset, topOffset - 1);

		// Jump to bottom via 'G'
		comp.handleInput("G");
		assert.equal(comp.getState().scrollOffset, 0);
		assert.equal(comp.getState().follow, true);

		comp.dispose();
	});
});
