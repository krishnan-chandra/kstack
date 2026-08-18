import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type DashboardTheme, renderDashboard } from "../shared/live-dashboard.ts";
import { ParallelAgentsDashboardStore } from "./live-dashboard.ts";

const theme: DashboardTheme = { fg: (_color, text) => text };

describe("ParallelAgentsDashboardStore", () => {
	it("renders Simplify agents through the shared dashboard", () => {
		const store = new ParallelAgentsDashboardStore("simplify", () => 1000);
		store.addAgent("quality", "quality", "openai/model");
		store.markRunning("quality");
		store.progress("quality", { turns: 2, activity: "read scope.txt", preview: "one finding" });
		const rendered = renderDashboard(store, 100, theme).join("\n");
		assert.match(rendered, /■ Simplify — 0\/1 done/);
		assert.match(rendered, /quality — running \(openai\/model\) · 2t · read scope\.txt/);
		assert.match(rendered, /one finding/);
	});

	it("renders Arena candidates with the same component", () => {
		const store = new ParallelAgentsDashboardStore("arena", () => 1000);
		store.addAgent("terra", "terra", "openai/terra");
		store.complete("terra", { status: "completed", turns: 3 });
		const rendered = renderDashboard(store, 80, theme).join("\n");
		assert.match(rendered, /■ Arena — 1\/1 done/);
		assert.match(rendered, /terra — completed \(openai\/terra\) · 3t/);
	});
});
