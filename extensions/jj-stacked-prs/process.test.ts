import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { runCommand, type SpawnedProcess } from "./process.ts";

class FakeProcess implements SpawnedProcess {
	stdout = new EventEmitter() as SpawnedProcess["stdout"] & EventEmitter;
	stderr = new EventEmitter() as SpawnedProcess["stderr"] & EventEmitter;
	private events = new EventEmitter();
	kills: string[] = [];
	pid = 4242;
	killed = false;
	ignoreTerm = false;
	/** When false, kill() models a child that is already gone and never emits "close". */
	closeOnKill = true;

	on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	on(event: "error", cb: (error: Error) => void): void;
	on(
		event: "close" | "error",
		cb: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
	): void {
		this.events.on(event, cb);
	}
	kill(signal = "SIGTERM"): boolean {
		this.killed = true;
		this.kills.push(signal);
		if (!this.closeOnKill) return false;
		if (signal === "SIGTERM" && this.ignoreTerm) return true;
		queueMicrotask(() => this.emitClose(null, signal as NodeJS.Signals));
		return true;
	}
	emitClose(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.events.emit("close", code, signal);
	}
	emitError(error: Error): void {
		this.events.emit("error", error);
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

describe("process runner", () => {
	it("decodes UTF-8 split across chunks", async () => {
		const child = new FakeProcess();
		const pending = runCommand(["echo"], { cwd: "/tmp" }, () => child);
		const cafe = Buffer.from("café", "utf8");
		child.stdout.emit("data", cafe.subarray(0, 4));
		child.stdout.emit("data", cafe.subarray(4));
		child.emitClose(0);
		const result = await pending;
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.equal(result.stdout, "café");
	});

	it("caps stdout while reading", async () => {
		const child = new FakeProcess();
		const pending = runCommand(["echo"], { cwd: "/tmp", stdoutCapBytes: 4, killGraceMs: 5 }, () => child);
		child.stdout.emit("data", Buffer.from("12345"));
		child.emitClose(0);
		const result = await pending;
		assert.equal(result.kind, "overflow");
		if (result.kind === "overflow") assert.equal(result.stream, "stdout");
		assert.deepEqual(child.kills, ["SIGTERM"]);
	});

	it("caps stderr while reading", async () => {
		const child = new FakeProcess();
		const pending = runCommand(["echo"], { cwd: "/tmp", stderrCapBytes: 3, killGraceMs: 5 }, () => child);
		child.stderr.emit("data", Buffer.from("abcd"));
		child.emitClose(1);
		const result = await pending;
		assert.equal(result.kind, "overflow");
		if (result.kind === "overflow") assert.equal(result.stream, "stderr");
	});

	it("reports synchronous spawn failure", async () => {
		const result = await runCommand(["missing"], { cwd: "/tmp" }, () => {
			throw new Error("ENOENT");
		});
		assert.equal(result.kind, "spawn-failed");
	});

	it("reports asynchronous spawn failure", async () => {
		const child = new FakeProcess();
		const pending = runCommand(["missing"], { cwd: "/tmp" }, () => child);
		child.emitError(new Error("spawn ENOENT"));
		const result = await pending;
		assert.equal(result.kind, "spawn-failed");
	});

	it("times out, sends SIGTERM, then SIGKILL after grace", async () => {
		const child = new FakeProcess();
		child.ignoreTerm = true;
		const pending = runCommand(["sleep"], { cwd: "/tmp", timeoutMs: 10, killGraceMs: 15 }, () => child);
		const result = await pending;
		assert.equal(result.kind, "timeout");
		assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
	});

	it("cancels on abort", async () => {
		const child = new FakeProcess();
		const controller = new AbortController();
		const pending = runCommand(["sleep"], { cwd: "/tmp", signal: controller.signal, killGraceMs: 5 }, () => child);
		controller.abort();
		child.emitClose(null, "SIGTERM");
		const result = await pending;
		assert.equal(result.kind, "cancelled");
	});

	it("settles as cancelled when error fires after abort without close", async () => {
		const child = new FakeProcess();
		child.closeOnKill = false;
		const controller = new AbortController();
		const pending = runCommand(["sleep"], { cwd: "/tmp", signal: controller.signal, killGraceMs: 5 }, () => child);
		controller.abort();
		child.emitError(new Error("boom"));
		const result = await withTimeout(pending, 500);
		assert.equal(result.kind, "cancelled");
	});

	it("settles as timeout when error fires after timeout without close", async () => {
		const child = new FakeProcess();
		child.closeOnKill = false;
		const pending = runCommand(["sleep"], { cwd: "/tmp", timeoutMs: 5, killGraceMs: 60_000 }, () => child);
		await new Promise((resolve) => setTimeout(resolve, 20));
		child.emitError(new Error("boom"));
		const result = await withTimeout(pending, 500);
		assert.equal(result.kind, "timeout");
	});

	it("reports an uncertain close when there is no exit code", async () => {
		const child = new FakeProcess();
		const pending = runCommand(["sleep"], { cwd: "/tmp" }, () => child);
		child.emitClose(null, "SIGKILL");
		const result = await pending;
		assert.equal(result.kind, "uncertain");
	});

	it("returns bounded redacted diagnostics", async () => {
		const child = new FakeProcess();
		const pending = runCommand(["gh"], { cwd: "/tmp" }, () => child);
		child.stderr.emit("data", Buffer.from("https://x-access-token:SECRET@github.com/o/r"));
		child.emitClose(1);
		const result = await pending;
		assert.equal(result.kind, "nonzero");
		if (result.kind === "nonzero") assert.match(result.message, /\*\*\*/);
	});
});
