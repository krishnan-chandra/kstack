import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	KSTACK_HOSTED_AGENT_NAME_ENV,
	KSTACK_HOSTED_AGENT_STATE_ENV,
	readHostedAgentState,
	writeHostedAgentState,
} from "./agent-state.ts";
import { registerHostedAgentStateReporter } from "./state-reporter.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kstack-agent-state-"));
	roots.push(dir);
	return dir;
}

type EventHandler = (event: undefined, ctx: ExtensionContext) => void | Promise<void>;

function createFakePi() {
	const handlers = new Map<string, EventHandler[]>();
	// SAFETY: This test double implements only pi.on() exercised by registerHostedAgentStateReporter.
	const pi: ExtensionAPI = {
		on(event: string, handler: EventHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
	} as never;
	return {
		pi,
		handlers,
		async emit(event: string, ctx: ExtensionContext) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(undefined, ctx);
			}
		},
	};
}

function fakeCtx(options: {
	mode?: "tui" | "rpc" | "json" | "print";
	cwd?: string;
	sessionFile?: string;
	sessionId?: string;
}): ExtensionContext {
	// SAFETY: This test double implements the ExtensionContext fields read by registerHostedAgentStateReporter.
	return {
		mode: options.mode ?? "tui",
		cwd: options.cwd ?? "/repo",
		sessionManager: {
			getSessionFile: () => options.sessionFile,
			getSessionId: () => options.sessionId ?? "",
		},
	} as never;
}

describe("agent-state reader and writer", () => {
	it("writes atomically with 0600 permissions and reads valid records", () => {
		const dir = makeDir();
		const stateFile = join(dir, "agents", "seat-a.json");
		writeHostedAgentState(stateFile, {
			version: 1,
			name: "council-demo-a",
			pid: 4242,
			cwd: "/repo",
			sessionFile: "/sessions/a.jsonl",
			sessionId: "sess-1",
			updatedAt: "2026-11-11T21:00:00.000Z",
		});
		assert.equal(statSync(stateFile).mode & 0o777, 0o600);
		assert.deepEqual(readHostedAgentState(stateFile), {
			version: 1,
			name: "council-demo-a",
			pid: 4242,
			cwd: "/repo",
			sessionFile: "/sessions/a.jsonl",
			sessionId: "sess-1",
			updatedAt: "2026-11-11T21:00:00.000Z",
		});
	});

	it("accepts initial pre-session records and rejects malformed or invalid records", () => {
		const dir = makeDir();
		const stateFile = join(dir, "state.json");
		assert.equal(readHostedAgentState(stateFile), undefined);

		writeHostedAgentState(stateFile, {
			version: 1,
			name: "worker",
			pid: 99,
			cwd: "/repo",
			updatedAt: "2026-11-11T21:00:00.000Z",
		});
		assert.equal(readHostedAgentState(stateFile)?.sessionFile, undefined);

		writeFileSync(stateFile, "{bad json");
		assert.equal(readHostedAgentState(stateFile), undefined);

		writeFileSync(
			stateFile,
			JSON.stringify({ version: 2, name: "x", pid: 1, cwd: "/repo", updatedAt: "2026-11-11T21:00:00.000Z" }),
		);
		assert.equal(readHostedAgentState(stateFile), undefined);

		writeFileSync(
			stateFile,
			JSON.stringify({ version: 1, name: "x", pid: 0, cwd: "/repo", updatedAt: "2026-11-11T21:00:00.000Z" }),
		);
		assert.equal(readHostedAgentState(stateFile), undefined);

		writeFileSync(
			stateFile,
			JSON.stringify({
				version: 1,
				name: "x",
				pid: 10,
				cwd: "/repo",
				sessionFile: "relative/session.jsonl",
				updatedAt: "2026-11-11T21:00:00.000Z",
			}),
		);
		assert.equal(readHostedAgentState(stateFile), undefined);
	});
});

describe("registerHostedAgentStateReporter", () => {
	it("registers nothing when KSTACK_HOSTED_AGENT_STATE is unset or relative", () => {
		const unset = createFakePi();
		registerHostedAgentStateReporter(unset.pi, { env: {} });
		assert.equal(unset.handlers.size, 0);

		const relative = createFakePi();
		registerHostedAgentStateReporter(relative.pi, {
			env: { [KSTACK_HOSTED_AGENT_STATE_ENV]: "relative/state.json" },
		});
		assert.equal(relative.handlers.size, 0);
	});

	it("ignores non-tui modes and updates the sidecar on startup, runs, and session switches", async () => {
		const dir = makeDir();
		const stateFile = join(dir, "agents", "worker.json");
		let tick = 0;
		const fake = createFakePi();
		registerHostedAgentStateReporter(fake.pi, {
			env: {
				[KSTACK_HOSTED_AGENT_STATE_ENV]: stateFile,
				[KSTACK_HOSTED_AGENT_NAME_ENV]: "swarm-worker-0001",
			},
			pid: 12345,
			now: () => `2026-11-11T21:00:0${++tick}.000Z`,
		});

		await fake.emit("session_start", fakeCtx({ mode: "json", sessionFile: "/sessions/headless.jsonl" }));
		assert.equal(existsSync(stateFile), false);

		await fake.emit(
			"session_start",
			fakeCtx({ cwd: "/repo-a", sessionFile: "/sessions/first.jsonl", sessionId: "s1" }),
		);
		assert.deepEqual(readHostedAgentState(stateFile), {
			version: 1,
			name: "swarm-worker-0001",
			pid: 12345,
			cwd: "/repo-a",
			sessionFile: "/sessions/first.jsonl",
			sessionId: "s1",
			updatedAt: "2026-11-11T21:00:01.000Z",
		});

		await fake.emit("agent_start", fakeCtx({ cwd: "/repo-a", sessionFile: "/sessions/first.jsonl", sessionId: "s1" }));
		assert.equal(readHostedAgentState(stateFile)?.updatedAt, "2026-11-11T21:00:02.000Z");

		// A /new, /resume, or /fork rebinds and emits session_start with the new session file.
		await fake.emit(
			"session_start",
			fakeCtx({ cwd: "/repo-a", sessionFile: "/sessions/switched.jsonl", sessionId: "s2" }),
		);
		assert.equal(readHostedAgentState(stateFile)?.sessionFile, "/sessions/switched.jsonl");
		assert.equal(readHostedAgentState(stateFile)?.sessionId, "s2");
	});
});
