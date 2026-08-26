import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestStackCapabilities } from "../shared/stack/channel.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import githubStackedPrsExtension, { renderOutcome } from "./index.ts";

function mockPi() {
	const handlers = new Map<string, Array<(value: BoundaryValue) => void>>();
	const commands: string[] = [];
	const tools: string[] = [];
	const pi = {
		events: {
			on: (event: string, handler: (value: BoundaryValue) => void) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
			emit: (event: string, value: BoundaryValue) => {
				for (const handler of handlers.get(event) ?? []) handler(value);
			},
		},
		on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
	};
	return { pi, commands, tools };
}

describe("github-stacked-prs extension", () => {
	it("bounds rendered outcomes by UTF-8 bytes", () => {
		const rendered = renderOutcome({ status: "failed", error: "🧪".repeat(30_000) });
		assert.ok(Buffer.byteLength(rendered, "utf8") <= 50 * 1024);
		assert.equal(rendered.includes("�"), false);
	});

	it("claims GitHub capabilities and registers its one command/tool pair", async () => {
		const { pi, commands, tools } = mockPi();
		githubStackedPrsExtension(
			/* SAFETY: Test double matches the ExtensionAPI subset used at registration. */ pi as never,
		);
		const result = await requestStackCapabilities(
			/* SAFETY: Test double implements the request-channel event bus. */ pi as never,
			"github",
		);
		assert.deepEqual(result, {
			handled: true,
			outcome: { schemaVersion: 1, publication: true, commands: ["publish"], tools: ["gh_stack_publish"] },
		});
		assert.deepEqual(commands, ["gh-stack"]);
		assert.deepEqual(tools, ["gh_stack_publish"]);
	});
});
