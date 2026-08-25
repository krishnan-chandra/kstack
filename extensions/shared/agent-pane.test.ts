import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getAgentPaneHost } from "./agent-pane.ts";
import type { BoundaryValue } from "./validation.ts";

interface FakeUiState {
	widgets: Map<string, unknown>;
	customCalls: number;
	component?: Component;
	closeCustom?: () => void;
	notifications: string[];
}

function setup(mode: ExtensionContext["mode"] = "tui") {
	const shortcuts = new Map<string, (ctx: ExtensionContext) => void>();
	const handlers = new Map<string, () => void>();
	const state: FakeUiState = {
		widgets: new Map(),
		customCalls: 0,
		notifications: [],
	};
	const ui = {
		setWidget(key: string, content: BoundaryValue) {
			if (content === undefined) state.widgets.delete(key);
			else state.widgets.set(key, content);
		},
		notify(message: string) {
			state.notifications.push(message);
		},
		custom(factory: (...args: BoundaryValue[]) => Component) {
			state.customCalls++;
			let resolve!: () => void;
			const closed = new Promise<void>((done) => {
				resolve = done;
			});
			const done = () => resolve();
			state.closeCustom = done;
			state.component = factory(
				{ requestRender() {}, terminal: { rows: 24 } },
				{ fg: (_color: string, text: string) => text },
				{},
				done,
			);
			return closed;
		},
	};
	const ctx = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		mode,
		ui,
	} as ExtensionContext;
	const pi = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		registerShortcut(key: string, value: { handler: (ctx: ExtensionContext) => void }) {
			shortcuts.set(key, value.handler);
		},
		on(event: string, handler: () => void) {
			handlers.set(event, handler);
		},
	} as ExtensionAPI;
	return { pi, ctx, shortcuts, handlers, state };
}

function renderWidget(state: FakeUiState): string {
	const factory =
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ state.widgets.get(
			"kstack-agent-pane",
		) as
			| ((tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }) => Component)
			| undefined;
	assert.ok(factory);
	return factory({ requestRender() {} }, { fg: (_color, text) => text })
		.render(100)
		.join("\n");
}

describe("agent pane host", () => {
	it("registers one shortcut pair and reuses the host", () => {
		const { pi, shortcuts, handlers } = setup();
		const first = getAgentPaneHost(pi);
		const second = getAgentPaneHost(pi);
		assert.equal(first, second);
		assert.deepEqual([...shortcuts.keys()], ["ctrl+shift+v", "ctrl+shift+x"]);
		assert.ok(handlers.has("session_shutdown"));
	});

	it("reuses the host across isolated module graphs", async () => {
		const { pi, shortcuts } = setup();
		const first = getAgentPaneHost(pi);
		const isolated = await import(`./agent-pane.ts?isolated=${Date.now()}`);
		assert.equal(isolated.getAgentPaneHost(pi), first);
		assert.equal(shortcuts.size, 2);
	});

	it("mounts a uniform pane, opens the console, and routes abort", () => {
		const { pi, ctx, shortcuts, state } = setup();
		let aborts = 0;
		const run = getAgentPaneHost(pi).startRun({ ctx, title: "Simplify", onAbort: () => aborts++ });
		run.addChild({ id: "quality", label: "quality", model: "model/a" });
		run.markRunning("quality");
		run.note("quality", "Reviewer started");
		assert.match(renderWidget(state), /■ Simplify/);
		assert.match(renderWidget(state), /\^⇧V view · \^⇧X abort/);

		shortcuts.get("ctrl+shift+v")?.(ctx);
		assert.equal(state.customCalls, 1);
		assert.match(state.component?.render(100).join("\n") ?? "", /Simplify/);
		shortcuts.get("ctrl+shift+x")?.(ctx);
		assert.equal(aborts, 1);
		state.component?.handleInput?.("\x1b[120;6u");
		assert.equal(aborts, 2);
		run.dispose();
		assert.equal(state.widgets.size, 0);
	});

	it("restores a parent pane after a nested run disposes", () => {
		const { pi, ctx, state } = setup();
		const host = getAgentPaneHost(pi);
		const parent = host.startRun({ ctx, title: "Plan & implement", onAbort() {} });
		parent.addChild({ id: "planner", label: "Planner", model: "model/p" });
		parent.note("planner", "parent transcript");
		assert.match(renderWidget(state), /Plan & implement/);

		const nested = host.startRun({ ctx, title: "Panel review", onAbort() {} });
		nested.addChild({ id: "reviewer", label: "Reviewer", model: "model/r" });
		assert.match(renderWidget(state), /Panel review/);
		nested.dispose();
		assert.match(renderWidget(state), /Plan & implement/);
		parent.dispose();
	});

	it("closes overlays and all runs idempotently on shutdown", () => {
		const { pi, ctx, shortcuts, handlers, state } = setup();
		const host = getAgentPaneHost(pi);
		const run = host.startRun({ ctx, title: "Arena", onAbort() {} });
		run.addChild({ id: "a", label: "a", model: "model/a" });
		shortcuts.get("ctrl+shift+v")?.(ctx);
		assert.equal(state.customCalls, 1);
		handlers.get("session_shutdown")?.();
		handlers.get("session_shutdown")?.();
		assert.equal(state.widgets.size, 0);

		const next = host.startRun({ ctx, title: "Simplify", onAbort() {} });
		next.addChild({ id: "b", label: "b", model: "model/b" });
		assert.match(renderWidget(state), /Simplify/);
		next.dispose();
	});

	it("does not mount widgets or open consoles outside TUI mode", () => {
		const { pi, ctx, shortcuts, state } = setup("json");
		const run = getAgentPaneHost(pi).startRun({ ctx, title: "Arena", onAbort() {} });
		run.addChild({ id: "a", label: "a", model: "model/a" });
		shortcuts.get("ctrl+shift+v")?.(ctx);
		assert.equal(state.widgets.size, 0);
		assert.equal(state.customCalls, 0);
		run.dispose();
	});
});
