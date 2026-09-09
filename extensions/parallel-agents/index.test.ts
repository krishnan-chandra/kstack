import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import parallelAgentsExtension, { nestedUsage } from "./index.ts";

interface RegisteredTool {
	name: string;
	parameters: object;
	execute: (...args: unknown[]) => Promise<object>;
}

const session = { kind: "missing", reason: "not-reported" } as const;

describe("parallel-agents extension", () => {
	it("registers the model-callable tool and shutdown cleanup", () => {
		let tool: RegisteredTool | undefined;
		const handlers = new Map<string, () => void>();
		const pi = {
			registerShortcut() {},
			registerTool(value: RegisteredTool) {
				tool = value;
			},
			on(event: string, handler: () => void) {
				handlers.set(event, handler);
			},
		};
		// SAFETY: The test double implements the ExtensionAPI methods exercised during registration.
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Pi owns the full interface; this test exercises registration only.
		parallelAgentsExtension(pi as unknown as ExtensionAPI);
		assert.equal(tool?.name, "parallel_agents");
		assert.ok(handlers.has("session_shutdown"));
	});

	it("exposes only the read-only Simplify task contract", () => {
		let tool: RegisteredTool | undefined;
		const pi = {
			registerShortcut() {},
			registerTool(value: RegisteredTool) {
				tool = value;
			},
			on() {},
		};
		// SAFETY: The test double implements the ExtensionAPI methods exercised during registration.
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Pi owns the full interface; this test exercises registration only.
		parallelAgentsExtension(pi as unknown as ExtensionAPI);
		assert.ok(tool);
		const schema = JSON.stringify(tool.parameters);
		assert.doesNotMatch(schema, /workspace|arena|access|kind/i);
	});

	it("reserves one run synchronously and aborts it on shutdown", async () => {
		let tool: RegisteredTool | undefined;
		let shutdown: (() => void) | undefined;
		let childSignal: AbortSignal | undefined;
		const pi = {
			registerShortcut() {},
			registerTool(value: RegisteredTool) {
				tool = value;
			},
			on(event: string, handler: () => void) {
				if (event === "session_shutdown") shutdown = handler;
			},
		};
		// SAFETY: The test double implements the ExtensionAPI methods exercised during registration.
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Pi owns the full interface; this test exercises registration only.
		parallelAgentsExtension(pi as unknown as ExtensionAPI, {
			runAgents: async ({ tasks, signal }) => {
				childSignal = signal;
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				return tasks.map((task) => ({
					status: "aborted" as const,
					label: task.label,
					model: task.model,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				}));
			},
		});
		assert.ok(tool);
		const params = { tasks: [{ label: "a", model: "model/a", prompt: "review" }] };
		const ctx = { cwd: "/repo", mode: "rpc", ui: { setStatus() {} } };
		const first = tool.execute("call-1", params, undefined, undefined, ctx);
		await assert.rejects(tool.execute("call-2", params, undefined, undefined, ctx), /already active/);
		shutdown?.();
		await first;
		assert.equal(childSignal?.aborted, true);
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
