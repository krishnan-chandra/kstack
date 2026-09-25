import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TObject } from "typebox";
import { HANDOFF_HISTORY_TOOLS } from "./history-access.ts";
import handoffExtension from "./index.ts";

interface RegisteredTool {
	name: string;
	description: string;
	parameters: TObject;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

function mockPi() {
	const commands: string[] = [];
	const tools: RegisteredTool[] = [];
	const pi = {
		on: () => {},
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: RegisteredTool) => tools.push(tool),
	};
	return { pi, commands, tools };
}

describe("handoff extension registration", () => {
	it("registers /handoff and the history tools under the names the prompt uses", async () => {
		const { pi, commands, tools } = mockPi();
		await handoffExtension(/* SAFETY: Test double matches the ExtensionAPI subset used at registration. */ pi as never);

		assert.deepEqual(commands, ["handoff"]);
		assert.deepEqual(
			tools.map((tool) => tool.name),
			[HANDOFF_HISTORY_TOOLS.read, HANDOFF_HISTORY_TOOLS.search],
		);
		assert.deepEqual(Object.keys(tools[0].parameters.properties), [
			"view",
			"before",
			"full",
			"offset",
			"limit",
			"chunk",
			"from",
		]);
	});

	it("keeps the model-facing tool metadata within its byte budget", async () => {
		const { pi, tools } = mockPi();
		await handoffExtension(/* SAFETY: Test double matches the ExtensionAPI subset used at registration. */ pi as never);

		// Both tools' metadata is sent in every session: 1,952 bytes before the outline, plus at most 800.
		const bytes = tools.reduce(
			(sum, { name, description, parameters, promptSnippet, promptGuidelines }) =>
				sum + Buffer.byteLength(JSON.stringify({ name, description, parameters, promptSnippet, promptGuidelines })),
			0,
		);
		assert.ok(bytes <= 2752, `handoff tool metadata is ${bytes} bytes`);
	});
});
