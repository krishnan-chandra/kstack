import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getAgentPaneHost } from "../../shared/agent-pane.ts";
import type { BoundaryValue } from "../../shared/validation.ts";

const widgets = new Map<string, unknown>();
const shortcuts = new Map<string, (ctx: ExtensionContext) => void>();
let overlay: Component | undefined;
let closeOverlay: (() => void) | undefined;
const ui = {
	setWidget(key: string, content: BoundaryValue) {
		if (content === undefined) widgets.delete(key);
		else widgets.set(key, content);
	},
	notify() {},
	custom(factory: (...args: BoundaryValue[]) => Component) {
		let resolve!: () => void;
		const closed = new Promise<void>((done) => {
			resolve = done;
		});
		closeOverlay = resolve;
		overlay = factory(
			{ requestRender() {}, terminal: { rows: 20 } },
			{ fg: (_color: string, text: string) => text },
			{},
			resolve,
		);
		return closed;
	},
};
const ctx = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
	mode: "tui",
	ui,
} as never;
const pi = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
	registerShortcut(key: string, value: { handler: (ctx: ExtensionContext) => void }) {
		shortcuts.set(key, value.handler);
	},
	on() {},
} as never;

const run = getAgentPaneHost(pi).startRun({ ctx, title: "Simplify", onAbort() {} });
run.addChild({ id: "quality", label: "quality", model: "fixture/model-a" });
run.addChild({ id: "reuse", label: "reuse", model: "fixture/model-b" });
run.markRunning("quality");
run.markRunning("reuse");
run.note("quality", "Reviewer started");
run.event("quality", { kind: "tool_start", summary: "read scope.txt", at: 1 });
run.event("quality", { kind: "tool_end", durationMs: 10, at: 11 });
run.event("quality", { kind: "text_delta", delta: "live finding", at: 12 });
run.progress("quality", { turns: 1, activity: "read scope.txt", preview: "checking" });

const factory = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ widgets.get(
	"kstack-agent-pane",
) as (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }) => Component;
const dashboard = factory({ requestRender() {} }, { fg: (_color, text) => text });
assert.match(dashboard.render(100).join("\n"), /■ Simplify/);
assert.match(dashboard.render(100).join("\n"), /read scope\.txt/);

shortcuts.get("ctrl+shift+v")?.(ctx);
assert.ok(overlay);
assert.match(overlay.render(120).join("\n"), /live finding/);
overlay.handleInput?.("\x1b[C");
assert.match(overlay.render(120).join("\n"), /fixture\/model-b/);
overlay.handleInput?.("\x1b");
closeOverlay?.();
run.complete("quality", { status: "completed", turns: 1 });
run.complete("reuse", { status: "completed", turns: 1 });
run.dispose();
assert.equal(widgets.size, 0);
console.log("parallel-agents pane smoke test passed");
