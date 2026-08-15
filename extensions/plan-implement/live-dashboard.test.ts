import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	codePointWidth,
	type DashboardTheme,
	mountPlanImplementDashboard,
	PlanImplementDashboardComponent,
	PlanImplementDashboardStore,
	renderDashboard,
	rowElapsedSeconds,
	sanitizeDisplayText,
	stripTerminalSequencesFallback,
	type TerminalText,
} from "./live-dashboard.ts";

const fakeTheme: DashboardTheme = {
	fg: (_color, text) => text,
};

const fakeText: TerminalText = {
	stripTerminalSequences: stripTerminalSequencesFallback,
	truncateToWidth: (t, w) => (t.length > w ? `${t.slice(0, Math.max(0, w - 1))}…` : t),
};

describe("PlanImplementDashboardStore", () => {
	it("seeds queued planner and implementer phases and emits updates", () => {
		let clock = 1000;
		let emissions = 0;
		const store = new PlanImplementDashboardStore(() => clock);
		store.subscribe(() => {
			emissions++;
		});

		store.addPhase("planner", "Planner", "model/planner", "planner");
		store.addPhase("implementer", "Implementer", "model/implementer", "implementer");
		assert.equal(store.getRows().length, 2);
		assert.equal(store.getRows()[0].status, "queued");
		assert.equal(store.getRows()[1].status, "queued");
		assert.equal(emissions, 2);

		clock = 2000;
		store.markRunning("planner");
		assert.equal(store.getRows()[0].status, "running");
		assert.equal(store.getRows()[0].startedAt, 2000);

		clock = 3000;
		store.progress("planner", { turns: 2, activity: "read file.ts", preview: "Thinking about plan" });
		assert.equal(store.getRows()[0].turns, 2);
		assert.equal(store.getRows()[0].activity, "read file.ts");
		assert.equal(store.getRows()[0].preview, "Thinking about plan");

		clock = 4000;
		store.complete("planner", { status: "completed", turns: 3 });
		assert.equal(store.getRows()[0].status, "completed");
		assert.equal(store.getRows()[0].finishedAt, 4000);
		assert.equal(store.getRows()[0].turns, 3);
		assert.equal(store.getRows()[0].activity, undefined);

		const summary = store.summary();
		assert.deepEqual(summary, { total: 2, completed: 1, failed: 0, aborted: 0, running: 0 });
	});

	it("computes row elapsed seconds", () => {
		const store = new PlanImplementDashboardStore(() => 5000);
		store.addPhase("planner", "Planner", "model/planner", "planner");
		assert.equal(rowElapsedSeconds(store.getRows()[0], 5000), undefined);

		store.markRunning("planner");
		assert.equal(rowElapsedSeconds(store.getRows()[0], 8000), 3);

		store.complete("planner", { status: "completed" });
		assert.equal(rowElapsedSeconds(store.getRows()[0], 10000), 0);
	});

	it("ignores updates for unknown phase id", () => {
		const store = new PlanImplementDashboardStore();
		store.markRunning("unknown");
		store.progress("unknown", { turns: 1 });
		store.complete("unknown", { status: "completed" });
		assert.equal(store.getRows().length, 0);
	});

	it("ignores duplicate addPhase calls", () => {
		const store = new PlanImplementDashboardStore();
		store.addPhase("planner", "Planner", "model/planner", "planner");
		store.addPhase("planner", "Planner 2", "model/planner 2", "planner");
		assert.equal(store.getRows().length, 1);
		assert.equal(store.getRows()[0].label, "Planner");
	});
});

describe("renderDashboard", () => {
	it("renders width-safe lines with status, models, activity, and preview", () => {
		let clock = 10000;
		const store = new PlanImplementDashboardStore(() => clock);
		store.addPhase("planner", "Planner", "anthropic/claude-3-7-sonnet", "planner");
		store.addPhase("implementer", "Implementer", "anthropic/claude-3-7-sonnet", "implementer");

		clock = 12000;
		store.markRunning("planner");
		store.progress("planner", { turns: 3, activity: "grep pattern", preview: "Here is step 1" });

		clock = 14000;
		const lines = renderDashboard(store, 100, fakeTheme, fakeText);
		assert.ok(lines.length >= 3);
		assert.match(lines[0], /■ Plan & implement/);
		assert.match(lines[0], /\^⇧P inspect/);
		assert.match(lines[0], /\^⇧I abort/);
		assert.match(lines[1], /● Planner — running \(anthropic\/claude-3-7-sonnet\)/);
		assert.match(lines[1], /3t · 2s · grep pattern/);
		assert.match(lines[2], /› Here is step 1/);
		assert.match(lines[3], /○ Implementer — queued/);
	});

	it("adapts to narrow terminals by hiding preview, activity, and models", () => {
		const store = new PlanImplementDashboardStore(() => 1000);
		store.addPhase("planner", "Planner", "very-long-model-name", "planner");
		store.markRunning("planner");
		store.progress("planner", { turns: 1, activity: "doing things", preview: "some preview" });

		// Narrow width 30: hides model and activity, includes preview if >= 24
		const lines30 = renderDashboard(store, 30, fakeTheme, fakeText);
		assert.ok(!lines30[1].includes("very-long-model-name"));
		assert.ok(!lines30[1].includes("doing things"));

		// Ultra narrow width 20: hides preview
		const lines20 = renderDashboard(store, 20, fakeTheme, fakeText);
		assert.equal(lines20.length, 2); // Header + Planner line
	});
});

describe("sanitizeDisplayText and helpers", () => {
	it("strips ANSI sequences and collapses whitespace", () => {
		const sanitized = sanitizeDisplayText("\x1b[31mRed \x1b[0m \n\t Text \r\n");
		assert.equal(sanitized, "Red Text");
	});

	it("calculates codePointWidth correctly", () => {
		assert.equal(codePointWidth("a".charCodeAt(0)), 1);
		assert.equal(codePointWidth(0x4e2d), 2); // Chinese character
		assert.equal(codePointWidth(0x0a), 0); // newline
	});
});

describe("mountPlanImplementDashboard", () => {
	it("mounts widget and disposes cleanly", () => {
		const store = new PlanImplementDashboardStore();
		let widgetKey: string | undefined;
		let widgetFactory: unknown;
		const ui = {
			setWidget(key: string, content: unknown) {
				widgetKey = key;
				widgetFactory = content;
			},
		};

		const unmount = mountPlanImplementDashboard(ui, store, fakeText);
		assert.equal(widgetKey, "plan-implement");
		assert.equal(typeof widgetFactory, "function");

		unmount();
		assert.equal(widgetFactory, undefined);
	});

	it("PlanImplementDashboardComponent renders and invalidates", () => {
		const store = new PlanImplementDashboardStore();
		store.addPhase("planner", "Planner", "model/p", "planner");
		let renders = 0;
		const tui = {
			requestRender: () => {
				renders++;
			},
		};
		const component = new PlanImplementDashboardComponent(store, tui, fakeTheme, fakeText);
		const lines = component.render(80);
		assert.ok(lines.length >= 2);

		component.invalidate();
		store.markRunning("planner");
		assert.equal(renders, 1);

		component.dispose();
		store.complete("planner", { status: "completed" });
		assert.equal(renders, 1);
	});
});
