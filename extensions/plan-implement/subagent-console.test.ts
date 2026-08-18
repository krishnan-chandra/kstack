import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DashboardTheme } from "../shared/live-dashboard.ts";
import { PlanImplementDashboardStore } from "./live-dashboard.ts";
import { openSubagentConsole } from "./subagent-console.ts";
import { PlanImplementTranscriptStore } from "./transcript-store.ts";

const fakeTheme: DashboardTheme = {
	fg: (_color: string, text: string) => text,
};

describe("plan-implement subagent console wrapper", () => {
	it("opens full-screen with plan/implement copy and renders the console chrome", async () => {
		const dashboard = new PlanImplementDashboardStore(() => 1000);
		dashboard.addPhase("planner", "Planner", "model/planner", "planner");
		const transcripts = new PlanImplementTranscriptStore(() => 1000, 0);
		transcripts.addChild("planner");

		let customOptions: unknown;
		let factory: unknown;
		const ctx = {
			ui: {
				custom: async (f: unknown, options: unknown) => {
					factory = f;
					customOptions = options;
				},
			},
		};

		const result = openSubagentConsole(ctx as unknown as ExtensionContext, dashboard, transcripts);
		assert.deepEqual(customOptions, {
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
		});

		// Invoke the captured factory the way ctx.ui.custom would and render the component.
		const component = (
			factory as (
				tui: unknown,
				theme: DashboardTheme,
				kb: unknown,
				done: () => void,
			) => {
				render(width: number): string[];
				dispose(): void;
			}
		)({ requestRender: () => {}, terminal: { rows: 20 } }, fakeTheme, undefined, () => {});
		const wide = component.render(120);
		assert.match(wide[0], /Plan & implement/);
		assert.match(wide.join("\n"), /Planner/);
		assert.match(wide[18], /\^⇧I abort/);
		component.dispose();

		result.close();
		await result.closed;
	});

	it("uses the plan/implement empty message when no phases exist", async () => {
		const dashboard = new PlanImplementDashboardStore(() => 1000);
		const transcripts = new PlanImplementTranscriptStore(() => 1000, 0);

		let factory: unknown;
		const ctx = {
			ui: {
				custom: async (f: unknown) => {
					factory = f;
				},
			},
		};
		const result = openSubagentConsole(ctx as unknown as ExtensionContext, dashboard, transcripts);
		const component = (
			factory as (
				tui: unknown,
				theme: DashboardTheme,
				kb: unknown,
				done: () => void,
			) => {
				render(width: number): string[];
				dispose(): void;
			}
		)({ requestRender: () => {}, terminal: { rows: 20 } }, fakeTheme, undefined, () => {});
		assert.deepEqual(component.render(120), ["No plan/implement phases active"]);
		component.dispose();
		result.close();
		await result.closed;
	});
});
