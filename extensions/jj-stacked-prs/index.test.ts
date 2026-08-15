import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jjStackedPrsExtension from "./index.ts";

describe("jj-stacked-prs registration", () => {
	it("registers commands, tools, events, and a shortcut without launching a subprocess", () => {
		const commands: string[] = [];
		const tools: string[] = [];
		const events: string[] = [];
		const shortcuts: string[] = [];
		const sessionHandlers: Array<() => void> = [];
		jjStackedPrsExtension({
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
		} as never);
		assert.deepEqual(commands, ["jj-stack"]);
		assert.deepEqual(tools, ["jj_stack_inspect", "jj_stack_plan"]);
		assert.ok(events.includes("session_start"));
		assert.ok(events.includes("session_shutdown"));
		assert.ok(shortcuts.includes("ctrl+shift+j"));
		for (const handler of sessionHandlers) handler();
	});
});
