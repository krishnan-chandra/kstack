import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { type ChildEvent, childIsolationArgs, runChildAgent, type SpawnedProcess } from "./child-agent-runner.ts";

class FakeProcess implements SpawnedProcess {
	stdin = {
		writes: [] as string[],
		ended: false,
		write: (data: string) => {
			this.stdin.writes.push(data);
			return true;
		},
		end: () => {
			this.stdin.ended = true;
		},
	};
	stdout = new EventEmitter() as SpawnedProcess["stdout"] & EventEmitter;
	stderr = new EventEmitter() as SpawnedProcess["stderr"] & EventEmitter;
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
		this.stdout.emit("data", Buffer.from(text));
	}
}

function event(text: string, extra: Record<string, unknown> = {}): string {
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

function run(child: FakeProcess, overrides: Record<string, unknown> = {}) {
	return runChildAgent({
		args: ["--mode", "json"],
		cwd: "/repo",
		deps: {
			spawnImpl: () => child,
			piInvocation: (args) => ({ command: "pi", args }),
			killGraceMs: 5,
			outputCapBytes: 1024,
			stderrCapBytes: 64,
			stdoutLineCapBytes: 1024,
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
			"--no-session",
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
			"--no-session",
			"--no-extensions",
			"--no-prompt-templates",
		]);
	});

	it("adds --no-context-files after prompt-template isolation", () => {
		assert.deepEqual(childIsolationArgs({ noContextFiles: true }), [
			"--mode",
			"json",
			"-p",
			"--no-session",
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
			"--no-session",
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
			"--no-session",
			"--no-extensions",
			"--no-prompt-templates",
			"--no-context-files",
		]);
	});
});

describe("runChildAgent", () => {
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
			signal: controller.signal,
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }), killGraceMs: 5 },
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
			stdin: "secret",
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }) },
		});
		assert.deepEqual(child.stdin.writes, ["secret"]);
		assert.equal(child.stdin.ended, true);
		child.output(event("ok"));
		child.close(0);
		assert.equal((await promise).status, "completed");
	});
	it("emits structured ChildEvents in order", async () => {
		const child = new FakeProcess();
		const events: ChildEvent[] = [];
		const promise = runChildAgent({
			args: ["--mode", "json"],
			cwd: "/repo",
			onEvent: (ev) => events.push(ev),
			deps: { spawnImpl: () => child, piInvocation: (args) => ({ command: "pi", args }) },
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
			assert.equal(typeof events[1].durationMs, "number");
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
