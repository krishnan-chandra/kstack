import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
	type ChildEvent,
	childIsolationArgs,
	runChildAgent,
	type SpawnedProcess,
	type SubagentSessionStore,
	truncateHeadUtf8,
} from "./child-agent-runner.ts";
import { isObject, type JsonObject } from "./validation.ts";

const sessionStore: SubagentSessionStore = {
	prepare: (_identity, cwd) => ({
		ok: true,
		prepared: {
			id: "00000000-0000-4000-8000-000000000001",
			name: "test/child",
			root: "/sessions",
			expectedCwd: cwd,
			cliArgs: ["--session-id", "00000000-0000-4000-8000-000000000001"],
			leaseFile: "/sessions/.active/test.json",
		},
	}),
	markSpawned: () => ({ ok: true }),
	finish: (prepared) => ({ kind: "persisted", id: prepared.id, name: prepared.name, file: "/sessions/test.jsonl" }),
};

class FakeStdin extends EventEmitter {
	writes: string[] = [];
	ended = false;
	writeError?: Error;
	endError?: Error;
	write(data: string): boolean {
		if (this.writeError) throw this.writeError;
		this.writes.push(data);
		return true;
	}
	end(): void {
		if (this.endError) throw this.endError;
		this.ended = true;
	}
}

class FakeProcess implements SpawnedProcess {
	private headerSent = false;
	stdin = new FakeStdin();
	stdout =
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ new EventEmitter() as SpawnedProcess["stdout"] &
			EventEmitter;
	stderr =
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ new EventEmitter() as SpawnedProcess["stderr"] &
			EventEmitter;
	private events = new EventEmitter();
	killed = false;
	kills: string[] = [];
	on(event: "close", cb: (code: number | null) => void): void;
	on(event: "error", cb: (error: Error) => void): void;
	on(event: "close" | "error", cb: ((code: number | null) => void) | ((error: Error) => void)): void {
		this.events.on(event, cb);
	}
	kill(signal = "SIGTERM"): boolean {
		this.killed = true;
		this.kills.push(signal);
		return true;
	}
	close(code: number | null): void {
		this.events.emit("close", code);
	}
	error(error: Error): void {
		this.events.emit("error", error);
	}
	output(text: string): void {
		if (!this.headerSent) {
			this.headerSent = true;
			this.stdout.emit(
				"data",
				Buffer.from(
					`${JSON.stringify({ type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" })}\n`,
				),
			);
		}
		this.stdout.emit("data", Buffer.from(text));
	}
}

function event(text: string, extra: JsonObject = {}): string {
	return `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 } },
			...extra,
		},
	})}\n`;
}

function run(child: FakeProcess, overrides: JsonObject = {}) {
	return runChildAgent({
		args: ["--mode", "json"],
		cwd: "/repo",
		session: { owner: "test", label: "child" },
		deps: {
			spawnImpl: () => child,
			piInvocation: (args) => ({ command: "pi", args }),
			killGraceMs: 5,
			outputCapBytes: 1024,
			stderrCapBytes: 64,
			stdoutLineCapBytes: 1024,
			sessionStore,
			...overrides,
		},
	});
}

describe("childIsolationArgs", () => {
	it("returns the default isolation prefix with skills disabled", () => {
		assert.deepEqual(childIsolationArgs(), [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
		]);
	});

	it("keeps skills when noSkills is false", () => {
		assert.deepEqual(childIsolationArgs({ noSkills: false }), [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--no-prompt-templates",
		]);
	});

	it("adds --no-context-files after prompt-template isolation", () => {
		assert.deepEqual(childIsolationArgs({ noContextFiles: true }), [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		]);
	});

	it("adds classifier tool isolation after context-file isolation", () => {
		assert.deepEqual(childIsolationArgs({ noContextFiles: true, noToolsNoApprove: true }), [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-tools",
			"--no-approve",
		]);
	});

	it("can keep skills while still disabling context files", () => {
		assert.deepEqual(childIsolationArgs({ noSkills: false, noContextFiles: true }), [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--no-prompt-templates",
			"--no-context-files",
		]);
	});
});

describe("runChildAgent", () => {
	it("returns a failed result when a real child closes stdin before reading a large prompt", async () => {
		const runnerUrl = pathToFileURL(resolve("extensions/shared/child-agent-runner.ts")).href;
		const script = `
			import { runChildAgent } from ${JSON.stringify(runnerUrl)};
			const id = "00000000-0000-4000-8000-000000000001";
			const sessionStore = {
				prepare: (_identity, cwd) => ({ ok: true, prepared: { id, name: "test/stdin", root: "/sessions", expectedCwd: cwd, cliArgs: [], leaseFile: "/lease" } }),
				markSpawned: () => ({ ok: true }),
				finish: () => ({ kind: "missing", reason: "not-reported" }),
			};
			const result = await runChildAgent({
				args: [],
				cwd: process.cwd(),
				session: { owner: "test", label: "stdin" },
				stdin: "private-prompt-marker" + "x".repeat(512 * 1024),
				deps: {
					piInvocation: () => ({ command: process.execPath, args: ["--input-type=module", "-e", "import fs from 'node:fs'; fs.closeSync(0); process.exit(0);"] }),
					sessionStore,
					killGraceMs: 10,
				},
			});
			process.stdout.write(JSON.stringify(result));
		`;
		const outer = spawn(process.execPath, ["--input-type=module", "-e", script], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		outer.stdout.on("data", (chunk: Buffer) => {
			stdout = truncateHeadUtf8(stdout + chunk.toString("utf8"), 64 * 1024, "outer stdout");
		});
		outer.stderr.on("data", (chunk: Buffer) => {
			stderr = truncateHeadUtf8(stderr + chunk.toString("utf8"), 64 * 1024, "outer stderr");
		});
		const exitCode = await new Promise<number | null>((resolveClose) => outer.on("close", resolveClose));

		assert.equal(exitCode, 0, stderr);
		const result: unknown = JSON.parse(stdout);
		assert.ok(isObject(result));
		assert.ok("status" in result);
		assert.equal(result.status, "failed");
		assert.doesNotMatch(stdout + stderr, /private-prompt-marker/);
	});

	it("completes with final output and accumulated usage", async () => {
		const child = new FakeProcess();
		const promise = run(child);
		child.output(event("first"));
		child.output(event("final"));
		child.close(0);
		const result = await promise;
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.equal(result.output, "final");
			assert.equal(result.usage.turns, 2);
			assert.equal(result.usage.input, 4);
		}
	});
	it("reports nonzero exits and bounded stderr", async () => {
		const child = new FakeProcess();
		const promise = run(child, { stderrCapBytes: 8 });
		child.stderr.emit("data", Buffer.from("provider failed badly"));
		child.close(1);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /provider/);
	});
	it("treats model error stops as failures", async () => {
		const child = new FakeProcess();
		const promise = run(child);
		child.output(event("", { stopReason: "error", errorMessage: "quota" }));
		child.close(0);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.equal(result.error, "quota");
	});
	it("aborts and escalates from SIGTERM to SIGKILL", async () => {
		const child = new FakeProcess();
		const controller = new AbortController();
		const promise = runChildAgent({
			args: [],
			cwd: "/repo",
			session: { owner: "test", label: "child" },
			signal: controller.signal,
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), killGraceMs: 5, sessionStore },
		});
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 15));
		assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
		child.close(null);
		assert.equal((await promise).status, "aborted");
	});
	it("kills a silent child at the idle limit", async () => {
		const child = new FakeProcess();
		const promise = run(child, { idleTimeoutMs: 5 });
		await new Promise((resolve) => setTimeout(resolve, 12));
		child.close(null);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /no output/);
	});
	it("enforces an absolute ceiling for a busy child", async () => {
		const child = new FakeProcess();
		const promise = run(child, { idleTimeoutMs: 50, maxRuntimeMs: 10 });
		const ticker = setInterval(() => child.output('{"type":"turn_start"}\n'), 2);
		await new Promise((resolve) => setTimeout(resolve, 18));
		clearInterval(ticker);
		child.close(null);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /max runtime/);
	});
	it("kills oversized JSONL as a protocol error", async () => {
		const child = new FakeProcess();
		const promise = run(child, { stdoutLineCapBytes: 8 });
		child.output("123456789\n");
		child.close(null);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /larger than 8 bytes/);
	});
	it("fails on empty successful output", async () => {
		const child = new FakeProcess();
		const promise = run(child);
		child.close(0);
		assert.equal((await promise).status, "failed");
	});
	it("pipes optional stdin", async () => {
		const child = new FakeProcess();
		const promise = runChildAgent({
			args: [],
			cwd: "/repo",
			session: { owner: "test", label: "child" },
			stdin: "secret",
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), sessionStore },
		});
		assert.deepEqual(child.stdin.writes, ["secret"]);
		assert.equal(child.stdin.ended, true);
		child.output(event("ok"));
		child.close(0);
		assert.equal((await promise).status, "completed");
	});
	it("fails prompt delivery on an asynchronous stdin error and finalizes once after close", async () => {
		const child = new FakeProcess();
		let finishCalls = 0;
		const countingStore: SubagentSessionStore = {
			...sessionStore,
			finish: (prepared, outcome) => {
				finishCalls++;
				return sessionStore.finish(prepared, outcome);
			},
		};
		const promise = runChildAgent({
			args: [],
			cwd: "/repo",
			session: { owner: "test", label: "child" },
			stdin: "private-prompt-marker",
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), sessionStore: countingStore },
		});
		const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		child.stdin.emit("error", error);
		assert.deepEqual(child.kills, ["SIGTERM"]);
		assert.equal(finishCalls, 0);
		child.close(0);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") {
			assert.match(result.error, /EPIPE/);
			assert.doesNotMatch(result.error, /private-prompt-marker/);
		}
		assert.equal(finishCalls, 1);
	});

	it("routes synchronous stdin write and end exceptions through close cleanup", async () => {
		for (const operation of ["write", "end"] as const) {
			const child = new FakeProcess();
			const error = Object.assign(new Error(`${operation} failed`), { code: `E${operation.toUpperCase()}` });
			if (operation === "write") child.stdin.writeError = error;
			else child.stdin.endError = error;
			const promise = runChildAgent({
				args: [],
				cwd: "/repo",
				session: { owner: "test", label: operation },
				stdin: "prompt",
				deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), sessionStore },
			});
			child.close(0);
			const result = await promise;
			assert.equal(result.status, "failed");
			if (result.status === "failed") assert.match(result.error, new RegExp(`E${operation.toUpperCase()}`));
		}
	});

	it("keeps abort precedence over a secondary stdin error", async () => {
		const child = new FakeProcess();
		const controller = new AbortController();
		const promise = runChildAgent({
			args: [],
			cwd: "/repo",
			session: { owner: "test", label: "abort-stdin" },
			stdin: "prompt",
			signal: controller.signal,
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), sessionStore },
		});
		controller.abort();
		child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
		child.close(null);
		assert.equal((await promise).status, "aborted");
	});

	it("keeps timeout precedence over a secondary stdin error", async () => {
		const child = new FakeProcess();
		const promise = runChildAgent({
			args: [],
			cwd: "/repo",
			session: { owner: "test", label: "timeout-stdin" },
			stdin: "prompt",
			deps: {
				spawnImpl: () => child,
				piInvocation: (args) => ({ command: "pi", args }),
				idleTimeoutMs: 5,
				sessionStore,
			},
		});
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
		child.close(null);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /Timed out/);
	});

	it("keeps the stdin error listener after child close", async () => {
		const child = new FakeProcess();
		const promise = runChildAgent({
			args: [],
			cwd: "/repo",
			session: { owner: "test", label: "late-stdin" },
			stdin: "prompt",
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), sessionStore },
		});
		child.output(event("done"));
		child.close(0);
		assert.equal((await promise).status, "completed");
		assert.doesNotThrow(() => child.stdin.emit("error", Object.assign(new Error("late"), { code: "EPIPE" })));
	});

	it("raises output and stderr caps via KSTACK_CHILD_DEBUG_CAP_BYTES", async () => {
		const previous = process.env.KSTACK_CHILD_DEBUG_CAP_BYTES;
		try {
			process.env.KSTACK_CHILD_DEBUG_CAP_BYTES = "2048";
			const child = new FakeProcess();
			const promise = run(child, { stdoutLineCapBytes: 4096 });
			const text = "a".repeat(1500);
			child.output(event(text));
			child.close(0);
			const result = await promise;
			assert.equal(result.status, "completed");
			if (result.status === "completed") {
				assert.equal(result.output, text);
				assert.ok(!result.output.includes("truncated"));
			}
		} finally {
			if (previous === undefined) delete process.env.KSTACK_CHILD_DEBUG_CAP_BYTES;
			else process.env.KSTACK_CHILD_DEBUG_CAP_BYTES = previous;
		}
	});
	it("ignores invalid KSTACK_CHILD_DEBUG_CAP_BYTES values", async () => {
		const previous = process.env.KSTACK_CHILD_DEBUG_CAP_BYTES;
		try {
			process.env.KSTACK_CHILD_DEBUG_CAP_BYTES = "invalid";
			const child = new FakeProcess();
			const promise = run(child);
			child.output(event("ok"));
			child.close(0);
			const result = await promise;
			assert.equal(result.status, "completed");
		} finally {
			if (previous === undefined) delete process.env.KSTACK_CHILD_DEBUG_CAP_BYTES;
			else process.env.KSTACK_CHILD_DEBUG_CAP_BYTES = previous;
		}
	});
	it("emits structured ChildEvents in order", async () => {
		const child = new FakeProcess();
		const events: ChildEvent[] = [];
		const promise = runChildAgent({
			args: ["--mode", "json"],
			cwd: "/repo",
			session: { owner: "test", label: "child" },
			onEvent: (ev) => events.push(ev),
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), sessionStore },
		});
		child.output(
			`${JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/repo/foo.ts" } })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		child.output(`${JSON.stringify({ type: "tool_execution_end" })}\n`);
		child.output(
			`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } })}\n`,
		);
		child.output(
			`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } })}\n`,
		);
		child.output(
			`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello world" }],
					usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cost: { total: 0.05 } },
				},
			})}\n`,
		);
		child.close(0);
		const result = await promise;
		assert.equal(result.status, "completed");
		assert.equal(events.length, 5);
		assert.equal(events[0].kind, "tool_start");
		if (events[0].kind === "tool_start") assert.equal(events[0].summary, "read foo.ts");
		assert.equal(events[1].kind, "tool_end");
		if (events[1].kind === "tool_end") {
			assert.notEqual(events[1].durationMs, undefined);
			assert.ok(events[1].durationMs! >= 0);
		}
		assert.equal(events[2].kind, "text_delta");
		if (events[2].kind === "text_delta") assert.equal(events[2].delta, "hello ");
		assert.equal(events[3].kind, "text_delta");
		if (events[3].kind === "text_delta") assert.equal(events[3].delta, "world");
		assert.equal(events[4].kind, "turn_end");
		if (events[4].kind === "turn_end") {
			assert.equal(events[4].turn, 1);
			assert.equal(events[4].text, "hello world");
			assert.equal(events[4].usage.input, 100);
			assert.equal(events[4].usage.output, 20);
			assert.equal(events[4].usage.cost, 0.05);
		}
	});
});
