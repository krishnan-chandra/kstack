import assert from "node:assert/strict";
import { describe, it } from "node:test";
import landExtension from "./index.ts";

describe("land registration", () => {
	it("registers the command, shortcut, renderer, and lifecycle handlers without launching a subprocess", () => {
		const commands: string[] = [];
		const shortcuts: string[] = [];
		const events: string[] = [];
		const renderers: string[] = [];
		const lifecycleHandlers: Array<() => void> = [];
		landExtension(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				on: (name: string, handler: () => void) => {
					events.push(name);
					if (name === "session_start" || name === "session_shutdown") lifecycleHandlers.push(handler);
				},
				registerShortcut: (name: string) => {
					shortcuts.push(name);
				},
				registerCommand: (name: string) => {
					commands.push(name);
				},
				registerMessageRenderer: (name: string) => {
					renderers.push(name);
				},
				events: { on: (name: string) => events.push(name) },
			} as never,
		);
		assert.deepEqual(commands, ["land"]);
		assert.ok(shortcuts.includes("ctrl+shift+l"));
		assert.deepEqual(renderers, ["land"]);
		assert.ok(events.includes("session_start"));
		assert.ok(events.includes("session_shutdown"));
		for (const handler of lifecycleHandlers) handler();
	});
});
