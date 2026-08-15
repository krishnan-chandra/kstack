import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatTokens,
	InspectorComponent,
	openInspector,
	renderInspector,
	sanitizeMultilineText,
	wrapAndSanitizeText,
} from "./inspector-overlay.ts";
import {
	type DashboardTheme,
	PlanImplementDashboardStore,
	stripTerminalSequencesFallback,
	type TerminalText,
} from "./live-dashboard.ts";
import { PlanImplementTranscriptStore } from "./transcript-store.ts";

const fakeTheme: DashboardTheme = {
	fg: (_color, text) => text,
};

const fakeText: TerminalText = {
	stripTerminalSequences: stripTerminalSequencesFallback,
	truncateToWidth: (t: string, w: number) => (t.length > w ? `${t.slice(0, Math.max(0, w - 1))}…` : t),
};

describe("inspector-overlay helpers", () => {
	it("sanitizes multiline text preserving newlines", () => {
		const raw = "Line 1\r\n\x1b[32mLine 2\x1b[0m\nLine 3";
		const clean = sanitizeMultilineText(raw, fakeText);
		assert.equal(clean, "Line 1\nLine 2\nLine 3");
	});

	it("formats token counts compactly", () => {
		assert.equal(formatTokens(500), "500");
		assert.equal(formatTokens(12000), "12k");
		assert.equal(formatTokens(12400), "12.4k");
	});

	it("wraps and sanitizes text", () => {
		const text = "The quick brown fox jumps over the lazy dog";
		const wrapped = wrapAndSanitizeText(text, 15, fakeText);
		assert.ok(wrapped.length > 1);
		for (const line of wrapped) {
			assert.ok(line.length <= 15);
		}
	});
});

describe("renderInspector", () => {
	it("renders tab bar, meta line, transcript entries, and help text", () => {
		const dashboard = new PlanImplementDashboardStore(() => 1000);
		dashboard.addPhase("planner", "Planner", "model/planner", "planner");
		dashboard.addPhase("implementer", "Implementer", "model/implementer", "implementer");
		dashboard.markRunning("planner");

		const transcripts = new PlanImplementTranscriptStore(() => 1000, 0);
		transcripts.addChild("planner");
		transcripts.addChild("implementer");
		transcripts.note("planner", "Planner started");
		transcripts.push("planner", { kind: "tool_start", summary: "grep pattern", at: 1100 });
		transcripts.push("planner", { kind: "tool_end", durationMs: 150, at: 1250 });
		transcripts.push("planner", {
			kind: "turn_end",
			turn: 1,
			text: "I analyzed the code.",
			usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 1 },
			at: 1500,
		});

		const lines = renderInspector(
			dashboard,
			transcripts,
			{ selectedIndex: 0, scrollOffset: 0, follow: true },
			80,
			20,
			fakeTheme,
			fakeText,
		);

		assert.equal(lines.length, 20);
		// Tab bar
		assert.match(lines[0], /Planner/);
		assert.match(lines[0], /Implementer/);
		// Meta line
		assert.match(lines[1], /model\/planner/);
		assert.match(lines[1], /running/);
		assert.match(lines[1], /\$0.005/);
		// Body
		const fullBody = lines.join("\n");
		assert.match(fullBody, /Planner started/);
		assert.match(fullBody, /grep pattern · 150ms/);
		assert.match(fullBody, /turn 1 · in 1k out 200/);
		assert.match(fullBody, /I analyzed the code/);
		// Help line
		assert.match(lines[19], /←→\/tab child/);
		assert.match(lines[19], /follow \[ON\]/);
	});

	it("renders fallback message when no children exist", () => {
		const dashboard = new PlanImplementDashboardStore();
		const transcripts = new PlanImplementTranscriptStore();
		const lines = renderInspector(
			dashboard,
			transcripts,
			{ selectedIndex: 0, scrollOffset: 0, follow: true },
			80,
			20,
			fakeTheme,
			fakeText,
		);
		assert.match(lines[0], /No plan\/implement phases active/);
	});
});

describe("InspectorComponent keyboard handling", () => {
	it("switches tabs, scrolls, toggles follow, and closes on escape", () => {
		const dashboard = new PlanImplementDashboardStore(() => 1000);
		dashboard.addPhase("planner", "Planner", "model/planner", "planner");
		dashboard.addPhase("implementer", "Implementer", "model/implementer", "implementer");

		const transcripts = new PlanImplementTranscriptStore(() => 1000, 0);
		transcripts.addChild("planner");
		transcripts.addChild("implementer");

		let closed = false;
		let aborted = false;
		let renderRequests = 0;
		const tui = {
			requestRender: () => {
				renderRequests++;
			},
			terminal: { rows: 24 },
		};

		const component = new InspectorComponent(
			dashboard,
			transcripts,
			tui,
			fakeTheme,
			() => {
				closed = true;
			},
			() => {
				aborted = true;
			},
			fakeText,
		);

		assert.equal(component.getState().selectedIndex, 0);

		// Switch tab right
		component.handleInput("\t");
		assert.equal(component.getState().selectedIndex, 1);

		// Switch tab left
		component.handleInput("\x1b[Z"); // shift+tab
		assert.equal(component.getState().selectedIndex, 0);

		// Toggle follow
		assert.equal(component.getState().follow, true);
		component.handleInput("f");
		assert.equal(component.getState().follow, false);
		component.handleInput("f");
		assert.equal(component.getState().follow, true);

		// Scroll up turns follow off
		component.handleInput("\x1b[A"); // up
		assert.equal(component.getState().follow, false);

		// Plain ctrl+x is intentionally ignored; the advertised shifted shortcut aborts.
		component.handleInput("\x18");
		assert.equal(aborted, false);
		component.handleInput("\x1b[105;6u"); // ctrl+shift+i
		assert.equal(aborted, true);

		// Escape
		component.handleInput("\x1b"); // escape
		assert.equal(closed, true);
		assert.ok(renderRequests > 0);

		component.dispose();
	});
});

describe("openInspector", () => {
	it("opens overlay and resolves when closed", async () => {
		const dashboard = new PlanImplementDashboardStore();
		dashboard.addPhase("planner", "Planner", "model/p", "planner");
		const transcripts = new PlanImplementTranscriptStore();
		transcripts.addChild("planner");

		let customOptions: unknown;
		const ctx = {
			ui: {
				custom: async (_factory: unknown, options: unknown) => {
					customOptions = options;
				},
			},
		};

		const inspector = openInspector(ctx as unknown as ExtensionContext, dashboard, transcripts, { text: fakeText });
		assert.deepEqual(customOptions, {
			overlay: true,
			overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
		});
		inspector.close();
		await inspector.closed;
	});
});
