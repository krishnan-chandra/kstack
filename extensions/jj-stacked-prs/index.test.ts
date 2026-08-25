import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JJ_STACK_LANDING_EVENT } from "./api.ts";
import jjStackedPrsExtension from "./index.ts";
import { combinePublicationSignals } from "./signals.ts";

describe("jj-stacked-prs registration", () => {
	it("registers commands, tools, events, and a shortcut without launching a subprocess", () => {
		const commands: string[] = [];
		const tools: string[] = [];
		const events: string[] = [];
		const shortcuts: string[] = [];
		const sessionHandlers: Array<() => void> = [];
		jjStackedPrsExtension(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				on: (name: string, handler: () => void) => {
					events.push(name);
					if (name === "session_start") sessionHandlers.push(handler);
				},
				registerShortcut: (name: string) => {
					shortcuts.push(name);
				},
				registerCommand: (name: string) => {
					commands.push(name);
				},
				registerTool: (tool: { name: string }) => {
					tools.push(tool.name);
				},
				events: { on: (name: string) => events.push(name) },
			} as never,
		);
		assert.deepEqual(commands, ["jj-stack"]);
		assert.deepEqual(tools, ["jj_stack_inspect", "jj_stack_plan", "jj_stack_publish", "jj_stack_land"]);
		assert.ok(events.includes("session_start"));
		assert.ok(events.includes("session_shutdown"));
		assert.ok(events.includes(JJ_STACK_LANDING_EVENT));
		assert.ok(shortcuts.includes("ctrl+shift+j"));
		for (const handler of sessionHandlers) handler();
	});

	it("aborts publication when the plan-implement command context is cancelled", () => {
		const session = new AbortController();
		const ctx = new AbortController();
		const combined = combinePublicationSignals(session.signal, ctx.signal);
		assert.equal(combined.aborted, false);
		ctx.abort();
		assert.equal(combined.aborted, true);
	});
});
