import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import parallelAgentsExtension, { nestedUsage } from "./index.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

const session = { kind: "missing", reason: "not-reported" } as const;

describe("parallel-agents extension", () => {
	it("registers the model-callable tool and shutdown cleanup", () => {
		let tool: RegisteredTool | undefined;
		const handlers = new Map<string, () => void>();
		const pi = {
			registerTool(value: RegisteredTool) {
				tool = value;
			},
			on(event: string, handler: () => void) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		parallelAgentsExtension(pi);
		assert.equal(tool?.name, "parallel_agents");
		assert.ok(handlers.has("session_shutdown"));
	});

	it("rejects a writable Arena task in the current repository before spawning", async () => {
		let tool: RegisteredTool | undefined;
		const root = mkdtempSync(join(tmpdir(), "parallel-agents-test-"));
		const pi = {
			registerTool(value: RegisteredTool) {
				tool = value;
			},
			on() {},
		} as unknown as ExtensionAPI;
		parallelAgentsExtension(pi);
		assert.ok(tool);
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: root }],
				},
				undefined,
				undefined,
				{ cwd: root },
			),
			/Writable Arena tasks cannot use the current repository root/,
		);
	});

	it("aggregates nested child usage for Pi session accounting", () => {
		const usage = nestedUsage([
			{
				status: "completed",
				label: "a",
				model: "model/a",
				output: "a",
				usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.4, turns: 1 },
				session,
			},
			{
				status: "failed",
				label: "b",
				model: "model/b",
				error: "boom",
				usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
				session,
			},
		]);
		assert.deepEqual(usage, {
			input: 15,
			output: 3,
			cacheRead: 3,
			cacheWrite: 1,
			totalTokens: 22,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		});
	});
});
