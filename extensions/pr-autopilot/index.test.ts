import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import prAutopilotExtension from "./index.ts";
import { config, createHarness, deferred } from "./test-harness.ts";

// Exercise the registered command and its real lifecycle/driver with only Pi's host effects stubbed.
for (const cancel of ["shutdown", "shortcut"] as const) {
	test(`${cancel} during a command refresh prevents repository mutations`, async (t) => {
		const harness = await createHarness({ mergeStateStatus: "BEHIND" });
		t.after(() => harness.cleanup());
		const agentDir = join(harness.cwd, "agent");
		await mkdir(agentDir);
		await writeFile(
			join(agentDir, "kstack.json"),
			JSON.stringify({
				"pr-autopilot": config,
				vcs: { backend: "git" },
			}),
		);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		t.after(() => {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		});

		const events = new Map<string, () => void>();
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		let shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1] | undefined;
		const notices: string[] = [];
		const refreshStarted = deferred<void>();
		const refreshed = deferred<void>();
		const host: Partial<ExtensionAPI> = {
			on(event, handler) {
				if (event === "session_shutdown") {
					// SAFETY: The registered shutdown callback ignores the host event and context.
					events.set(event, handler as () => void);
				}
			},
			registerCommand(_name, value) {
				command = value;
			},
			registerShortcut(_key, value) {
				shortcut = value;
			},
			registerMessageRenderer() {},
			sendMessage() {},
			events: { on: () => () => {}, emit() {} },
			exec: async (program, args, options) => {
				if (program === "gh" && args[0] === "pr" && args[1] === "view") {
					refreshStarted.resolve();
					await refreshed.promise;
				}
				const result = await harness.exec(program, args, { ...options, cwd: harness.cwd });
				return { ...result, killed: false };
			},
		};
		// SAFETY: This host supplies every Pi capability used by registration and the exercised command path.
		prAutopilotExtension(host as ExtensionAPI);
		assert.ok(command);
		assert.ok(shortcut);
		const shutdown = events.get("session_shutdown");
		assert.ok(shutdown);
		const context: Pick<ExtensionCommandContext, "cwd" | "mode" | "hasUI"> & {
			ui: Partial<ExtensionCommandContext["ui"]>;
		} = {
			cwd: harness.cwd,
			mode: "tui",
			hasUI: true,
			ui: {
				confirm: async () => true,
				notify: (message: string) => notices.push(message),
				setStatus() {},
			},
		};
		// SAFETY: This context supplies every capability used before cancellation ends the command.
		const ctx = context as ExtensionCommandContext;
		const pending = command.handler("--pr 42 --mode drive", ctx);
		await refreshStarted.promise;
		if (cancel === "shutdown") shutdown();
		else await shortcut.handler(ctx);
		refreshed.resolve();
		await pending;
		assert.ok(!harness.calls.some((call) => /^git (fetch|merge|push|add|commit)/.test(call)), harness.calls.join("\n"));
		if (cancel === "shortcut") assert.ok(notices.includes("PR autopilot aborted."));
	});
}
