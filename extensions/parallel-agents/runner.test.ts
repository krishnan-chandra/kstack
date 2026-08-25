import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { ChildEvent } from "../shared/child-agent-runner.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { buildParallelAgentArgs, runParallelAgent } from "./runner.ts";

const baseTask = {
	label: "quality",
	model: "openai/model:high",
	prompt: "review",
	cwd: "/repo",
} as const;

describe("parallel agent child arguments", () => {
	it("enforces the read-only tool boundary for Simplify", () => {
		const args = buildParallelAgentArgs({ ...baseTask, access: "read-only" });
		assert.deepEqual(args.slice(0, 7), [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		]);
		assert.deepEqual(args.slice(7), ["--tools", "read,grep,find,ls", "--model", "openai/model:high"]);
	});

	it("allows mutation tools only for isolated Arena workspaces", () => {
		const args = buildParallelAgentArgs({ ...baseTask, access: "workspace" });
		assert.ok(args.includes("read,grep,find,ls,write,edit,bash"));
		assert.ok(args.includes("--no-context-files"));
	});

	it("forwards structured child events", async () => {
		const events: ChildEvent[] = [];
		await runParallelAgent({
			owner: "simplify",
			task: { ...baseTask, access: "read-only" },
			onEvent: (event) => events.push(event),
			deps: {
				spawnImpl: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (() => {
					const events = new EventEmitter();
					const stdout = new EventEmitter();
					queueMicrotask(() => {
						stdout.emit(
							"data",
							Buffer.from(
								`${JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" })}\n${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "draft" } })}\n${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } })}\n`,
							),
						);
						events.emit("close", 0);
					});
					return {
						stdout,
						stderr: new EventEmitter(),
						stdin: { write: () => true, end() {} },
						on: (event: string, listener: (...args: BoundaryValue[]) => void) => events.on(event, listener),
						kill: () => true,
					};
				}) as never,
				piInvocation: (args) => ({ command: "pi", args }),
				sessionStore: {
					prepare: (_identity, cwd) => ({
						ok: true as const,
						prepared: {
							id: "00000000-0000-4000-8000-000000000001",
							name: "simplify/quality",
							root: "/sessions",
							expectedCwd: cwd,
							cliArgs: [],
							leaseFile: "/sessions/.active/test.json",
						},
					}),
					markSpawned: () => ({ ok: true as const }),
					finish: () => ({ kind: "missing" as const, reason: "not-reported" as const }),
				},
			},
		});
		assert.ok(events.some((event) => event.kind === "text_delta"));
	});
});
