import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { issueAutopilotConfirmation, requestPrAutopilot } from "./api.ts";
import prAutopilotExtension from "./index.ts";
import { config, createHarness, deferred } from "./test-harness.ts";

// Exercise the registered command and its real lifecycle/driver with only Pi's host effects stubbed.
test("standalone check scopes GitHub commands from a non-colocated jj origin", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const agentDir = join(harness.cwd, "agent");
	await mkdir(agentDir);
	await writeFile(
		join(agentDir, "kstack.json"),
		JSON.stringify({
			"pr-autopilot": config,
			vcs: { backend: "jj" },
		}),
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const identityCalls: string[] = [];
	const host: Partial<ExtensionAPI> = {
		on() {},
		registerCommand(_name, value) {
			command = value;
		},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { on: () => () => {}, emit() {} },
		exec: async (program, args, options) => {
			if (program === "jj" && args.join(" ") === "git remote list --no-pager --color=never") {
				return { code: 0, stdout: "origin git@github.com:owner/repo.git\n", stderr: "", killed: false };
			}
			if (program === "jj" && args.join(" ") === "git root") {
				identityCalls.push(`${program} ${args.join(" ")}`);
				return { code: 0, stdout: `${harness.cwd}\n`, stderr: "", killed: false };
			}
			if (program === "git" && args.includes("--git-common-dir")) {
				identityCalls.push(`${program} ${args.join(" ")}`);
				return { code: 0, stdout: `${harness.cwd}\n`, stderr: "", killed: false };
			}
			const result = await harness.exec(program, args, { ...options, cwd: harness.cwd });
			return { ...result, killed: false };
		},
	};
	prAutopilotExtension(
		/* SAFETY: This host supplies every Pi capability used by the exercised command path. */ host as ExtensionAPI,
	);
	assert.ok(command);
	const notices: string[] = [];
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
	await command.handler(
		"--pr 42 --mode check",
		/* SAFETY: This context supplies every capability used by the exercised command path. */ context as ExtensionCommandContext,
	);

	const repositoryCalls = harness.calls.filter((call) => /^gh (?:pr|run) /.test(call));
	assert.ok(repositoryCalls.length > 0);
	assert.ok(
		repositoryCalls.every((call) => call.endsWith(" --repo owner/repo")),
		repositoryCalls.join("\n"),
	);
	assert.ok(harness.calls.some((call) => call.includes("api repos/owner/repo/issues/42/comments")));
	assert.deepEqual(identityCalls, [
		"jj git root",
		`git --git-dir=${harness.cwd} rev-parse --path-format=absolute --git-common-dir`,
	]);
	assert.deepEqual(harness.unexpected, []);
	assert.ok(notices.some((message) => /looks merge-ready/i.test(message)));
});

test("delegated check uses its explicit repository from a .git-less jj workspace", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const agentDir = join(harness.cwd, "agent");
	await mkdir(agentDir);
	await writeFile(
		join(agentDir, "kstack.json"),
		JSON.stringify({
			"pr-autopilot": config,
			vcs: { backend: "jj" },
		}),
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const listeners = new Map<string, Array<(value: never) => void>>();
	const host: Partial<ExtensionAPI> = {
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: {
			on: (name, listener) => {
				const current = listeners.get(name) ?? [];
				current.push(listener);
				listeners.set(name, current);
				return () => {};
			},
			emit: (name, value) => {
				for (const listener of listeners.get(name) ?? []) {
					/* SAFETY: The test bus forwards the exact request emitted by the typed helper. */
					listener(value as never);
				}
			},
		},
		exec: async (program, args, options) => {
			assert.notEqual(program, "jj", "an explicit repository must skip cwd-based repository discovery");
			const result = await harness.exec(program, args, { ...options, cwd: harness.cwd });
			return { ...result, killed: false };
		},
	};
	prAutopilotExtension(
		/* SAFETY: This host supplies every Pi capability used by the delegated check path. */ host as ExtensionAPI,
	);
	const ctx = {
		cwd: harness.cwd,
		hasUI: true,
		ui: { notify() {}, setStatus() {} },
	};
	const result = await requestPrAutopilot(
		/* SAFETY: This host implements the typed request event bus. */ host as ExtensionAPI,
		"check",
		42,
		/* SAFETY: This context supplies every capability used by check mode. */ ctx as never,
		harness.cwd,
		issueAutopilotConfirmation(),
		undefined,
		"owner/repo",
	);

	assert.equal(result.handled, true);
	if (result.handled) assert.equal(result.outcome.status, "merge-ready");
	const repositoryCalls = harness.calls.filter((call) => /^gh (?:pr|run) /.test(call));
	assert.ok(
		repositoryCalls.every((call) => call.endsWith(" --repo owner/repo")),
		repositoryCalls.join("\n"),
	);
	assert.ok(harness.calls.some((call) => call.includes("api repos/owner/repo/issues/42/comments")));
	assert.ok(!harness.calls.some((call) => call.includes("{owner}")), harness.calls.join("\n"));
	assert.deepEqual(harness.unexpected, []);
});

test("delegated repository-resolution cancellation returns aborted without an error notification", async (t) => {
	const harness = await createHarness();
	t.after(() => harness.cleanup());
	const agentDir = join(harness.cwd, "agent");
	await mkdir(agentDir);
	await writeFile(join(agentDir, "kstack.json"), JSON.stringify({ vcs: { backend: "jj" } }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	const controller = new AbortController();
	const listeners = new Map<string, Array<(value: never) => void>>();
	const notices: Array<{ message: string; level: string }> = [];
	const host: Partial<ExtensionAPI> = {
		on() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: {
			on: (name, listener) => {
				const current = listeners.get(name) ?? [];
				current.push(listener);
				listeners.set(name, current);
				return () => {};
			},
			emit: (name, value) => {
				for (const listener of listeners.get(name) ?? []) {
					/* SAFETY: The test bus forwards the exact request value emitted by the typed helper. */
					listener(value as never);
				}
			},
		},
		exec: async (program, args) => {
			assert.equal(program, "jj");
			assert.equal(args.join(" "), "git remote list --no-pager --color=never");
			controller.abort();
			return { code: 130, stdout: "", stderr: "aborted", killed: true };
		},
	};
	prAutopilotExtension(
		/* SAFETY: This host supplies every Pi capability used before repository resolution is cancelled. */ host as ExtensionAPI,
	);
	const ctx = {
		cwd: harness.cwd,
		hasUI: true,
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
		},
	};
	const result = await requestPrAutopilot(
		/* SAFETY: This host implements the request event bus used by the helper. */ host as ExtensionAPI,
		"check",
		42,
		/* SAFETY: Repository cancellation occurs before any other context capability is used. */ ctx as never,
		harness.cwd,
		undefined,
		controller.signal,
	);

	assert.equal(result.handled, true);
	if (result.handled) {
		assert.equal(result.outcome.status, "aborted");
		assert.deepEqual(result.outcome.blockedReasons, ["repository resolution was cancelled"]);
	}
	assert.equal(
		notices.some((notice) => notice.level === "error"),
		false,
	);
});

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
