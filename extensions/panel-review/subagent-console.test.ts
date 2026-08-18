import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DashboardTheme } from "../shared/live-dashboard.ts";
import { PanelDashboardStore } from "./live-dashboard.ts";
import { openSubagentConsole } from "./subagent-console.ts";
import { PanelTranscriptStore } from "./transcript-store.ts";

const fakeTheme: DashboardTheme = {
	fg: (_color: string, text: string) => text,
};

describe("panel-review subagent console wrapper", () => {
	it("opens full-screen with panel copy and renders the console chrome", async () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		dashboard.addReviewer("r1", "alpha", "model-a");
		const transcripts = new PanelTranscriptStore(() => 1000);
		transcripts.addChild("r1");

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
		assert.match(wide[0], /Panel review/);
		assert.match(wide.join("\n"), /alpha/);
		assert.match(wide[18], /\^⇧X abort/);
		component.dispose();

		result.close();
		await result.closed;
	});

	it("uses the panel empty message when no children exist", async () => {
		const dashboard = new PanelDashboardStore(() => 1000);
		const transcripts = new PanelTranscriptStore(() => 1000);

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
		assert.deepEqual(component.render(120), ["No panel children active"]);
		component.dispose();
		result.close();
		await result.closed;
	});
});
