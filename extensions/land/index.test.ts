import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { requestStackFrontierLand } from "./api.ts";
import landExtension from "./index.ts";
import { StackLandingLifecycle } from "./lifecycle.ts";

describe("StackLandingLifecycle", () => {
	it("aborts the active provider request without owning nested single-PR runs", () => {
		const lifecycle = new StackLandingLifecycle();
		const signal = lifecycle.begin();
		assert.ok(signal);
		assert.equal(signal.aborted, false);
		assert.equal(lifecycle.abort(), true);
		assert.equal(signal.aborted, true);
		lifecycle.end(signal);
		assert.equal(lifecycle.abort(), false);
	});
});

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

	it("emits one result message for command and channel entry paths", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "kstack-land-index-"));
		writeFileSync(join(agentDir, "kstack.json"), `${JSON.stringify({ vcs: { backend: "git" } })}\n`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const SHA = "a".repeat(40);
			const listeners = new Map<string, Array<(value: never) => void>>();
			let commandHandler: ((text: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
			const messages: Array<{ customType: string; details: { status: string } }> = [];
			const pi = {
				on: () => {},
				registerShortcut: () => {},
				registerMessageRenderer: () => {},
				registerCommand: (_name: string, command: { handler: typeof commandHandler }) => {
					commandHandler = command.handler;
				},
				sendMessage: (message: { customType: string; details: { status: string } }) => messages.push(message),
				exec: async (_command: string, args: string[]) => {
					if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
					if (args[0] === "repo") {
						return {
							code: 0,
							stdout: JSON.stringify({
								nameWithOwner: "o/r",
								defaultBranchRef: { name: "main" },
								squashMergeAllowed: true,
								rebaseMergeAllowed: false,
							}),
							stderr: "",
						};
					}
					if (args[0] === "pr" && args[1] === "view") {
						return {
							code: 0,
							stdout: JSON.stringify({
								number: 7,
								url: "https://github.com/o/r/pull/7",
								title: "x",
								state: "OPEN",
								isDraft: false,
								headRefName: "feature",
								baseRefName: "main",
								headRefOid: SHA,
								mergeable: "MERGEABLE",
								mergeStateStatus: "CLEAN",
								mergedAt: null,
								mergeCommit: null,
							}),
							stderr: "",
						};
					}
					return { code: 0, stdout: "", stderr: "" };
				},
				events: {
					on: (name: string, listener: (value: never) => void) => {
						const current = listeners.get(name) ?? [];
						current.push(listener);
						listeners.set(name, current);
					},
					emit: (name: string, value: never) => {
						for (const listener of listeners.get(name) ?? []) listener(value);
					},
				},
			};
			landExtension(
				/* SAFETY: This fixture implements the Pi methods exercised by the registered paths. */ pi as never,
			);
			const ctx = /* SAFETY: The fixture supplies every context member exercised by command and channel handlers. */ {
				cwd: "/repo",
				hasUI: true,
				waitForIdle: async () => {},
				ui: {
					notify: () => {},
					setStatus: () => {},
					select: async () => "squash",
					confirm: async () => true,
				},
			} as never;
			assert.ok(commandHandler);
			await commandHandler("--pr 7 --method squash", ctx);
			await requestStackFrontierLand(/* SAFETY: This fixture implements the request event bus. */ pi as never, {
				options: { target: { kind: "single", prNumber: 7 }, readiness: "check", method: "squash", cwd: "/repo" },
				expectedHeadSha: SHA,
				ctx,
			});
			assert.deepEqual(
				messages.map((message) => [message.customType, message.details.status]),
				[
					["land", "blocked"],
					["land", "blocked"],
				],
			);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
