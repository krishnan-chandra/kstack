#!/usr/bin/env node
/**
 * Headless smoke test for the kstack-router Pi adapter (index.ts).
 *
 * Registers the real extension against a mock ExtensionAPI/ctx and drives
 * the full dispatch lifecycle: tool gating, playbook injection, one-shot
 * correlation, restoration on settle/shutdown/send-failure, and event-API
 * delegation for the change route.
 *
 * Run from the repository root:
 *   node extensions/kstack-router/scripts/smoke-mock-pi.mjs
 *
 * The script re-execs itself with --preserve-symlinks and assembles a temp
 * module-resolution sandbox (pi-tui and friends come from the installed
 * pi-coding-agent package; override with PI_PACKAGE_DIR).
 */

import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const EXTENSION_DIR = resolve(dirname(SCRIPT), "..");
const EXTENSIONS_ROOT = resolve(EXTENSION_DIR, "..");

// Re-exec with --preserve-symlinks so bare imports resolve through the temp
// sandbox instead of the repository's realpath.
if (!process.execArgv.includes("--preserve-symlinks")) {
	const result = spawnSync(process.execPath, ["--preserve-symlinks", SCRIPT], { stdio: "inherit" });
	process.exit(result.status ?? 1);
}

function findPiPackageDir() {
	if (process.env.PI_PACKAGE_DIR && existsSync(process.env.PI_PACKAGE_DIR)) {
		return process.env.PI_PACKAGE_DIR;
	}
	const candidates = [];
	try {
		candidates.push(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent"));
	} catch {
		// npm not available; fall through to well-known paths.
	}
	candidates.push(
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
	);
	for (const dir of candidates) {
		if (existsSync(join(dir, "node_modules", "@earendil-works", "pi-tui"))) return dir;
	}
	throw new Error("Could not locate the pi-coding-agent package; set PI_PACKAGE_DIR.");
}

const piPackageDir = findPiPackageDir();
const sandbox = mkdtempSync(join(tmpdir(), "kstack-smoke-"));
symlinkSync(join(piPackageDir, "node_modules"), join(sandbox, "node_modules"), "dir");
for (const name of ["kstack-router", "plan-implement", "fast-implement", "panel-review", "shared"]) {
	symlinkSync(join(EXTENSIONS_ROOT, name), join(sandbox, name), "dir");
}

const { default: kstackRouter } = await import(join(sandbox, "kstack-router", "index.ts"));
const { PLAN_IMPLEMENT_REQUEST_EVENT } = await import(join(sandbox, "plan-implement", "api.ts"));
const { FAST_IMPLEMENT_REQUEST_EVENT } = await import(join(sandbox, "fast-implement", "api.ts"));

// ---------------------------------------------------------------- mock Pi ---

function makePi({ activeTools, sessionName } = {}) {
	const handlers = new Map();
	const state = {
		tools: [...(activeTools ?? ["read", "grep", "find", "ls", "bash", "edit", "write"])],
		sessionName,
		setActiveToolsCalls: [],
		messages: [],
		userMessages: [],
		notifications: [],
		statuses: [],
		timeline: [],
		commands: new Map(),
		shortcuts: new Map(),
		busListeners: new Map(),
	};
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		registerMessageRenderer() {},
		registerShortcut(name, options) {
			state.shortcuts.set(name, options);
		},
		registerCommand(name, options) {
			state.commands.set(name, options);
		},
		getSessionName() {
			return state.sessionName;
		},
		setSessionName(name) {
			state.timeline.push(`name:${name}`);
			state.sessionName = name;
		},
		getCommands() {
			return [
				{ name: "plan-implement", source: "extension" },
				{ name: "panel-review", source: "extension" },
				{ name: "fast-implement", source: "extension" },
			];
		},
		getActiveTools() {
			return [...state.tools];
		},
		setActiveTools(names) {
			state.setActiveToolsCalls.push([...names]);
			state.tools = [...names];
		},
		sendMessage(message) {
			state.messages.push(message);
		},
		sendUserMessage(content) {
			state.userMessages.push(content);
		},
		events: {
			emit(channel, data) {
				for (const listener of state.busListeners.get(channel) ?? []) listener(data);
			},
			on(channel, listener) {
				if (!state.busListeners.has(channel)) state.busListeners.set(channel, []);
				state.busListeners.get(channel).push(listener);
			},
		},
	};
	async function fire(event, payload = {}) {
		const results = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx));
		}
		return results;
	}
	const ctx = {
		hasUI: true,
		cwd: "/repo",
		model: undefined,
		modelRegistry: {},
		ui: {
			notify(message, level) {
				state.notifications.push({ message, level });
			},
			setStatus(key, text) {
				state.statuses.push([key, text]);
			},
			async editor() {
				return undefined;
			},
			async select(_title, choices) {
				return choices[0];
			},
			async confirm() {
				return true;
			},
		},
		async waitForIdle() {
			state.timeline.push("wait");
		},
		getSystemPromptOptions() {
			return { skills: [{ name: "arena" }, { name: "swarm" }, { name: "create-skill" }] };
		},
	};
	return { pi, state, ctx, fire };
}

/** Simulate one agent turn: before_agent_start, then agent_settled. */
async function simulateTurn(env, prompt) {
	const injections = await env.fire("before_agent_start", {
		type: "before_agent_start",
		prompt,
		systemPrompt: "BASE-SYSTEM-PROMPT",
		systemPromptOptions: {},
	});
	await env.fire("agent_settled", { type: "agent_settled" });
	return injections.find((r) => r && typeof r === "object" && "systemPrompt" in r);
}

let passed = 0;
async function scenario(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (error) {
		console.error(`FAIL - ${name}`);
		console.error(error);
		process.exit(1);
	}
}

// Register the extension once per scenario for isolation.
function setup(options) {
	const env = makePi(options);
	kstackRouter(env.pi);
	env.fire("session_start", { type: "session_start" });
	return env;
}

// ------------------------------------------------------------ scenarios ---

await scenario("investigate gates tools, injects playbook once, restores on settle", async () => {
	const env = setup();
	const handler = env.state.commands.get("kstack").handler;

	await handler("--route investigate Explain the archive indexing", env.ctx);

	// Restricted to the read-only intersection before the turn started.
	assert.deepEqual(env.state.setActiveToolsCalls[0], ["read", "grep", "find", "ls"]);
	// The session is named from the routed task before the first agent turn.
	assert.equal(env.state.sessionName, "explain-archive-indexing");
	assert.deepEqual(env.state.timeline.slice(0, 2), ["name:explain-archive-indexing", "wait"]);
	// The task was delivered as a user message (triggers the agent turn).
	assert.deepEqual(env.state.userMessages, ["Explain the archive indexing"]);
	// A route card was displayed without triggering a turn itself.
	assert.ok(
		env.state.messages.some((m) => m.customType === "kstack-route" && m.details?.dispatchStatus === "dispatched"),
	);

	// First turn: playbook + principles injected into the system prompt.
	const injected = await simulateTurn(env, "Explain the archive indexing");
	assert.ok(injected, "before_agent_start must append the playbook");
	assert.ok(injected.systemPrompt.startsWith("BASE-SYSTEM-PROMPT"));
	assert.ok(injected.systemPrompt.includes("Investigate playbook"));

	// Exact tool snapshot restored after settlement.
	assert.deepEqual(env.state.setActiveToolsCalls.at(-1), ["read", "grep", "find", "ls", "bash", "edit", "write"]);

	// One-shot: the next ordinary turn gets no injection.
	const second = await simulateTurn(env, "ordinary follow-up");
	assert.equal(second, undefined);
});

await scenario("router preserves an explicit session name", async () => {
	const env = setup({ sessionName: "Existing session name" });
	const handler = env.state.commands.get("kstack").handler;
	await handler("--route investigate check this", env.ctx);
	assert.equal(env.state.sessionName, "Existing session name");
});

await scenario("tools are restored on session shutdown mid-dispatch", async () => {
	const env = setup();
	const handler = env.state.commands.get("kstack").handler;
	await handler("--route swarm audit the packages", env.ctx);
	assert.deepEqual(env.state.tools, ["read", "grep", "find", "ls"]);

	await env.fire("session_shutdown", { type: "session_shutdown" });
	assert.deepEqual(env.state.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);

	// A stale agent_settled after shutdown must not throw or restore again.
	const calls = env.state.setActiveToolsCalls.length;
	await env.fire("agent_settled", { type: "agent_settled" });
	assert.equal(env.state.setActiveToolsCalls.length, calls);
});

await scenario("tools are restored when starting the turn fails", async () => {
	const env = setup();
	env.pi.sendUserMessage = () => {
		throw new Error("agent busy");
	};
	const handler = env.state.commands.get("kstack").handler;
	await handler("--route investigate check this", env.ctx);
	assert.deepEqual(env.state.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
	assert.ok(env.state.notifications.some((n) => n.level === "error" && /agent busy/.test(n.message)));
});

await scenario("change route delegates the exact task, mode, and change kind to plan-implement", async () => {
	const env = setup();
	const seen = [];
	env.state.busListeners.set(PLAN_IMPLEMENT_REQUEST_EVENT, [
		(request) => {
			seen.push({ task: request.task, mode: request.mode, changeKind: request.changeKind });
			request.claimed = true;
			request.completion = Promise.resolve();
		},
	]);
	const handler = env.state.commands.get("kstack").handler;
	await handler('--route change --stack --change-kind feature "Split the feature into PRs"', env.ctx);
	assert.equal(env.state.sessionName, "split-feature-prs");
	assert.deepEqual(seen, [{ task: "Split the feature into PRs", mode: "stack", changeKind: "feature" }]);
	assert.ok(env.state.messages.some((m) => m.details?.dispatchStatus === "dispatched"));
});

await scenario("fast-change delegates exact task, location, and change kind to fast-implement", async () => {
	const env = setup();
	const seen = [];
	env.state.busListeners.set(FAST_IMPLEMENT_REQUEST_EVENT, [
		(request) => {
			seen.push({ task: request.task, workLocation: request.workLocation, changeKind: request.changeKind });
			request.claimed = true;
			request.completion = Promise.resolve();
		},
	]);
	await env.state.commands
		.get("kstack")
		.handler('--route fast-change --worktree --change-kind bug-fix "Fix the narrow bug"', env.ctx);
	assert.deepEqual(seen, [{ task: "Fix the narrow bug", workLocation: "worktree", changeKind: "bug-fix" }]);
});

await scenario("rejects a change-kind override when the final route is not change", async () => {
	const env = setup();
	const handler = env.state.commands.get("kstack").handler;
	await handler("--route investigate --change-kind feature Explain the archive", env.ctx);
	assert.ok(
		env.state.notifications.some(
			(n) => n.level === "warning" && /only valid with the change or fast-change routes/.test(n.message),
		),
	);
	assert.equal(env.state.messages.length, 0);
});

await scenario("review route passes the exact intent through the typed event API", async () => {
	const env = setup();
	const seen = [];
	env.state.busListeners.set("kstack:panel-review:request", [
		(request) => {
			seen.push(request.options);
			request.claimed = true;
			request.completion = Promise.resolve();
		},
	]);
	const handler = env.state.commands.get("kstack").handler;
	await handler('--route review "Look at \\"quoted\\" \\ paths"', env.ctx);
	assert.deepEqual(seen, [{ intent: 'Look at "quoted" \\ paths' }]);
});

console.log(`\n${passed} smoke scenarios passed`);
