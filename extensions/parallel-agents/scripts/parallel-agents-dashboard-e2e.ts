import assert from "node:assert/strict";
import { type DashboardTheme, type LiveDashboardComponent, mountLiveDashboard } from "../../shared/live-dashboard.ts";
import { ParallelAgentsDashboardStore } from "../live-dashboard.ts";

const widgets = new Map<string, unknown>();
const ui = {
	setWidget(key: string, content: unknown) {
		if (content === undefined) widgets.delete(key);
		else widgets.set(key, content);
	},
};
const store = new ParallelAgentsDashboardStore("simplify");
store.addAgent("quality", "quality", "fixture/model");
const dispose = mountLiveDashboard(ui, "parallel-agents", store);
const factory = widgets.get("parallel-agents") as (
	tui: { requestRender(): void },
	theme: DashboardTheme,
) => LiveDashboardComponent;
let renders = 0;
const component = factory({ requestRender: () => renders++ }, { fg: (_color, text) => text });
store.markRunning("quality");
store.progress("quality", { turns: 1, activity: "read scope.txt", preview: "checking" });
assert.ok(renders >= 2);
assert.match(component.render(100).join("\n"), /■ Simplify/);
assert.match(component.render(100).join("\n"), /read scope\.txt/);
dispose();
assert.ok(!widgets.has("parallel-agents"));
console.log("parallel-agents dashboard smoke test passed");
