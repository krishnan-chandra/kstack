import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonLineParser } from "../shared/pi-json-lines.ts";
import { buildChildArgs, runReviewer, summarizeToolCall, type SpawnImpl } from "./reviewer-runner.ts";
import type { ReviewerResult } from "./types.ts";

describe("JsonLineParser", () => {
	it("handles events split across chunks and skips malformed lines", () => {
		const events: unknown[] = [];
		const parser = new JsonLineParser((e) => events.push(e));
		parser.push('{"type":"mess');
		parser.push('age_end","message":{"role":"assistant"}}\nnot json\n{"type":"x"}\n');
		parser.push('{"type":"tail"}');
		parser.flush();
		assert.equal(events.length, 3);
		assert.deepEqual(events[0], { type: "message_end", message: { role: "assistant" } });
	});
});

describe("buildChildArgs", () => {
	it("is read-only with discovery disabled and no session", () => {
		const args = buildChildArgs({ model: "a/b:high", promptFile: "/tmp/p.md", task: "Review /tmp/b.md" });
		const joined = args.join(" ");
		assert.match(joined, /--mode json/);
		assert.match(joined, /--no-session/);
		assert.match(joined, /--no-extensions/);
		assert.match(joined, /--no-skills/);
		assert.match(joined, /--no-prompt-templates/);
		assert.match(joined, /--tools read,grep,find,ls/);
		assert.ok(!joined.includes("bash"));
		assert.ok(!joined.includes("write"));
		assert.ok(!joined.includes("edit"));
		assert.deepEqual(args[args.length - 1], "Review /tmp/b.md");
	});

	it("omits context files only when asked", () => {
		const base = buildChildArgs({ model: "a/b", promptFile: "/tmp/p.md", task: "t" });
		assert.ok(!base.includes("--no-context-files"));
		const stripped = buildChildArgs({ model: "a/b", promptFile: "/tmp/p.md", task: "t", noContextFiles: true });
		assert.ok(stripped.includes("--no-context-files"));
	});
});

interface FakeProcSpec {
	events?: object[];
	stderr?: string;
	exitCode?: number;
	/** Return text for final assistant message. */
	finalText?: string;
	usage?: { input?: number; output?: number; cost?: { total?: number } };
	stopReason?: string;
	errorMessage?: string;
	neverClose?: boolean;
	/** When set, kill() only closes the process for this signal. */
	closeOnSig?: string;
}

function fakeSpawn(spec: FakeProcSpec, onKill?: (sig: string) => void): SpawnImpl {
	return () => {
		const listeners: Record<string, ((d: Buffer) => void)[]> = { stdout: [], stderr: [] };
		const handlers: Record<string, ((v: never) => void)[]> = {};
		const proc = {
			killed: false,
			pid: undefined,
			stdout: { on: (_: "data", cb: (d: Buffer) => void) => listeners.stdout.push(cb) },
			stderr: { on: (_: "data", cb: (d: Buffer) => void) => listeners.stderr.push(cb) },
			on(event: string, cb: (v: never) => void) {
				(handlers[event] ??= []).push(cb);
			},
			kill(sig?: string) {
				proc.killed = true;
				onKill?.(sig ?? "SIGTERM");
				if (!spec.closeOnSig || sig === spec.closeOnSig) {
					queueMicrotask(() => handlers.close?.forEach((cb) => (cb as (c: number) => void)(143)));
				}
				return true;
			},
		};
		if (!spec.neverClose) {
			queueMicrotask(() => {
				const assistant = {
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: spec.finalText ?? "No findings" }],
						usage: spec.usage ?? {},
						stopReason: spec.stopReason,
						errorMessage: spec.errorMessage,
					},
				};
				for (const e of [...(spec.events ?? []), assistant]) {
					for (const cb of listeners.stdout) cb(Buffer.from(JSON.stringify(e) + "\n"));
				}
				if (spec.stderr) for (const cb of listeners.stderr) cb(Buffer.from(spec.stderr));
				handlers.close?.forEach((cb) => (cb as (c: number) => void)(spec.exitCode ?? 0));
			});
		}
		return proc;
	};
}

const specA = { label: "A", model: "a/b" };

function run(spec: FakeProcSpec, extra: Partial<Parameters<typeof runReviewer>[0]> = {}) {
	return runReviewer({
		spec: specA,
		model: "a/b",
		promptFile: "/tmp/p.md",
		task: "t",
		cwd: "/repo",
		deps: { spawnImpl: fakeSpawn(spec), killGraceMs: 1 },
		...extra,
	});
}

describe("summarizeToolCall", () => {
	it("prefers path basename and clips long values", () => {
		assert.equal(summarizeToolCall("read", { path: "/tmp/x/review-scope.ts" }), "read review-scope.ts");
		assert.equal(summarizeToolCall("grep", { pattern: "collectScope" }), "grep collectScope");
		assert.equal(summarizeToolCall("ls", {}), "ls");
		const long = summarizeToolCall("grep", { pattern: "x".repeat(80) });
		assert.ok(long.length <= 53); // "grep " + 47 chars + ellipsis
		assert.ok(long.endsWith("…"));
	});
});

describe("runReviewer", () => {
	it("reports tool activity through onProgress", async () => {
		const seen: { turns: number; activity?: string }[] = [];
		const r = await run(
			{
				events: [
					{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/repo/bundle.md" } },
					{ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false },
				],
			},
			{ onProgress: (info) => seen.push({ turns: info.turns, activity: info.activity }) },
		);
		assert.equal(r.status, "completed");
		assert.deepEqual(seen[0], { turns: 0, activity: "read bundle.md" });
		assert.deepEqual(seen[1], { turns: 0, activity: "thinking" });
		// Final assistant message carries the last known activity and the turn count.
		assert.deepEqual(seen.at(-1), { turns: 1, activity: "thinking" });
	});

	it("completes with final assistant text and usage", async () => {
		const r = await run({ finalText: "No findings", usage: { input: 10, output: 5, cost: { total: 0.01 } } });
		assert.equal(r.status, "completed");
		if (r.status === "completed") {
			assert.equal(r.output, "No findings");
			assert.equal(r.usage.input, 10);
			assert.equal(r.usage.turns, 1);
		}
	});

	it("fails on nonzero exit and preserves stderr", async () => {
		const r = await run({ exitCode: 2, stderr: "boom" });
		assert.equal(r.status, "failed");
		if (r.status === "failed") assert.match(r.error, /boom/);
	});

	it("fails when the model reports an error stop", async () => {
		const r = await run({ stopReason: "error", errorMessage: "provider exploded" });
		assert.equal(r.status, "failed");
		if (r.status === "failed") assert.match(r.error, /provider exploded/);
	});

	it("fails when there is no output", async () => {
		const r = await run({ finalText: "   " });
		assert.equal(r.status, "failed");
	});

	it("caps oversized output", async () => {
		const r = await runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			deps: { spawnImpl: fakeSpawn({ finalText: "x".repeat(10_000) }), outputCapBytes: 1000, killGraceMs: 1 },
		});
		assert.equal(r.status, "completed");
		if (r.status === "completed") {
			assert.ok(Buffer.byteLength(r.output, "utf8") < 1200);
			assert.match(r.output, /truncated/);
		}
	});

	it("aborts: SIGTERM then SIGKILL, result is aborted", async () => {
		const killed: string[] = [];
		const abort = new AbortController();
		const promise = runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			signal: abort.signal,
			deps: { spawnImpl: fakeSpawn({ neverClose: true }, (sig) => killed.push(sig)), killGraceMs: 5 },
		});
		abort.abort();
		const r = await promise;
		assert.equal(r.status, "aborted");
		assert.deepEqual(killed, ["SIGTERM"]);
	});

	it("escalates to SIGKILL when SIGTERM is ignored", async () => {
		const killed: string[] = [];
		const abort = new AbortController();
		const promise = runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			signal: abort.signal,
			deps: {
				spawnImpl: fakeSpawn({ neverClose: true, closeOnSig: "SIGKILL" }, (sig) => killed.push(sig)),
				killGraceMs: 5,
			},
		});
		abort.abort();
		const r = await promise;
		assert.equal(r.status, "aborted");
		assert.deepEqual(killed, ["SIGTERM", "SIGKILL"]);
	});

	it("times out when the child goes silent: SIGTERM then SIGKILL, result is failed", async () => {
		const killed: string[] = [];
		const r = await runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			deps: {
				spawnImpl: fakeSpawn({ neverClose: true, closeOnSig: "SIGKILL" }, (sig) => killed.push(sig)),
				killGraceMs: 5,
				timeoutMs: 10,
			},
		});
		assert.equal(r.status, "failed");
		if (r.status === "failed") assert.match(r.error, /Timed out: child produced no output for 10ms/);
		assert.deepEqual(killed, ["SIGTERM", "SIGKILL"]);
	});

	it("does not time out when the child finishes promptly", async () => {
		const killed: string[] = [];
		const r = await runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			deps: { spawnImpl: fakeSpawn({ finalText: "ok" }, (sig) => killed.push(sig)), killGraceMs: 5, timeoutMs: 1000 },
		});
		assert.equal(r.status, "completed");
		assert.deepEqual(killed, []);
	});
});

interface TimedChunk {
	atMs: number;
	text: string;
}

/** Fake child that emits stdout chunks on a schedule, then optionally closes. */
function timedSpawn(
	spec: { chunks: TimedChunk[]; closeAtMs?: number; finalText?: string },
	onKill?: (sig: string) => void,
): SpawnImpl {
	return () => {
		const listeners: Record<string, ((d: Buffer) => void)[]> = { stdout: [], stderr: [] };
		const handlers: Record<string, ((v: never) => void)[]> = {};
		const proc = {
			killed: false,
			pid: undefined,
			stdout: { on: (_: "data", cb: (d: Buffer) => void) => listeners.stdout.push(cb) },
			stderr: { on: (_: "data", cb: (d: Buffer) => void) => listeners.stderr.push(cb) },
			on(event: string, cb: (v: never) => void) {
				(handlers[event] ??= []).push(cb);
			},
			kill(sig?: string) {
				proc.killed = true;
				onKill?.(sig ?? "SIGTERM");
				queueMicrotask(() => handlers.close?.forEach((cb) => (cb as (c: number) => void)(143)));
				return true;
			},
		};
		for (const chunk of spec.chunks) {
			setTimeout(() => {
				for (const cb of listeners.stdout) cb(Buffer.from(chunk.text));
			}, chunk.atMs).unref();
		}
		if (spec.closeAtMs !== undefined) {
			setTimeout(() => {
				const assistant = {
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: spec.finalText ?? "done" }], usage: {} },
				};
				for (const cb of listeners.stdout) cb(Buffer.from(JSON.stringify(assistant) + "\n"));
				handlers.close?.forEach((cb) => (cb as (c: number) => void)(0));
			}, spec.closeAtMs).unref();
		}
		return proc;
	};
}

describe("runReviewer stall detection", () => {
	it("resets the idle timeout while the child produces output", async () => {
		const killed: string[] = [];
		const startedAt = Date.now();
		const r = await runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			deps: {
				// 200ms total runtime with output every 40ms; idle limit is 100ms.
				spawnImpl: timedSpawn(
					{ chunks: [40, 80, 120, 160].map((atMs) => ({ atMs, text: '{"type":"message_start"}\n' })), closeAtMs: 200, finalText: "ok" },
					(sig) => killed.push(sig),
				),
				killGraceMs: 5,
				timeoutMs: 100,
				maxRuntimeMs: 5000,
			},
		});
		assert.equal(r.status, "completed");
		assert.ok(Date.now() - startedAt >= 150, "child ran past the idle limit without being killed");
		assert.deepEqual(killed, []);
	});

	it("enforces the max runtime ceiling even when the child stays chatty", async () => {
		const killed: string[] = [];
		const chunks: TimedChunk[] = [];
		for (let atMs = 20; atMs <= 400; atMs += 20) chunks.push({ atMs, text: '{"type":"message_start"}\n' });
		const r = await runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			deps: {
				spawnImpl: timedSpawn({ chunks }, (sig) => killed.push(sig)),
				killGraceMs: 5,
				timeoutMs: 60_000, // idle never fires: output every 20ms
				maxRuntimeMs: 120,
			},
		});
		assert.equal(r.status, "failed");
		if (r.status === "failed") assert.match(r.error, /Timed out: exceeded max runtime of 120ms/);
		assert.deepEqual(killed, ["SIGTERM"]);
	});

	it("timeout failures carry turn, activity, and usage diagnostics", async () => {
		const r = await runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			deps: {
				spawnImpl: timedSpawn({
					chunks: [
						{ atMs: 10, text: JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/repo/extensions/panel-review/types.ts" } }) + "\n" },
						{ atMs: 20, text: JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read" }) + "\n" },
						{ atMs: 30, text: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: { input: 10 } } }) + "\n" },
					],
					// never closes: the child stalls after one completed turn
				}),
				killGraceMs: 5,
				timeoutMs: 90,
				maxRuntimeMs: 60_000,
			},
		});
		assert.equal(r.status, "failed");
		if (r.status === "failed") {
			assert.match(r.error, /no output for 90ms/);
			assert.match(r.error, /1 turns completed, last: thinking/);
			assert.equal(r.activity, "thinking");
			assert.equal(r.usage?.turns, 1);
			assert.equal(r.usage?.input, 10);
		}
	});
});

describe("runReviewer live text preview", () => {
	it("reconciles preview and turns at message_end while preserving tool activity", async () => {
		const seen: { turns: number; activity?: string; preview?: string }[] = [];
		const r = await run(
			{
				events: [
					{ type: "message_start", message: { role: "assistant" } },
					{ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/repo/x.ts" } },
					{ type: "tool_execution_end", toolCallId: "c1", toolName: "read" },
				],
				finalText: "The change looks safe.",
			},
			{ onProgress: (info) => seen.push({ ...info }) },
		);
		assert.equal(r.status, "completed");
		// message_start emits an initial progress event for the new turn.
		assert.deepEqual(seen[0], { label: "A", turns: 0, activity: undefined });
		// Tool activity then flows through as before.
		assert.deepEqual(seen[1], { label: "A", turns: 0, activity: "read x.ts" });
		assert.deepEqual(seen[2], { label: "A", turns: 0, activity: "thinking" });
		// message_end reconciles the preview to the authoritative assistant text.
		const last = seen.at(-1);
		assert.equal(last?.preview, "The change looks safe.");
		assert.equal(last?.turns, 1);
	});

	it("emits previews from raw split JSON chunks and ignores thinking deltas", async () => {
		const seen: { preview?: string }[] = [];
		const lines = [
			JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret reasoning" } }),
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }),
			JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } }),
		];
		// Split every JSON line across two chunks to exercise the streaming decoder.
		const spawnImpl: SpawnImpl = () => {
			const listeners: Record<string, ((d: Buffer) => void)[]> = { stdout: [], stderr: [] };
			const handlers: Record<string, ((v: never) => void)[]> = {};
			const proc = {
				killed: false,
				pid: undefined,
				stdout: { on: (_: "data", cb: (d: Buffer) => void) => listeners.stdout.push(cb) },
				stderr: { on: (_: "data", cb: (d: Buffer) => void) => listeners.stderr.push(cb) },
				on(event: string, cb: (v: never) => void) {
					(handlers[event] ??= []).push(cb);
				},
				kill() {
					proc.killed = true;
					queueMicrotask(() => handlers.close?.forEach((cb) => (cb as (c: number) => void)(143)));
					return true;
				},
			};
			queueMicrotask(() => {
				for (const line of lines) {
					const half = Math.floor(line.length / 2);
					for (const cb of listeners.stdout) cb(Buffer.from(line.slice(0, half)));
					for (const cb of listeners.stdout) cb(Buffer.from(line.slice(half) + "\n"));
				}
				const end = JSON.stringify({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], usage: {} },
				});
				for (const cb of listeners.stdout) cb(Buffer.from(end + "\n"));
				handlers.close?.forEach((cb) => (cb as (c: number) => void)(0));
			});
			return proc;
		};
		const r = await runReviewer({
			spec: specA,
			model: "a/b",
			promptFile: "/tmp/p.md",
			task: "t",
			cwd: "/repo",
			deps: { spawnImpl, killGraceMs: 1 },
			onProgress: (info) => seen.push({ preview: info.preview }),
		});
		assert.equal(r.status, "completed");
		const previews = seen.map((s) => s.preview).filter((p): p is string => p !== undefined);
		assert.ok(previews.includes("Hello "), `growing previews: ${JSON.stringify(previews)}`);
		assert.ok(previews.includes("Hello world"));
		assert.ok(!previews.some((p) => p.includes("secret reasoning")), "thinking deltas must not leak");
	});

	it("resets the preview when a new assistant message starts", async () => {
		const seen: { preview?: string }[] = [];
		const r = await run(
			{
				events: [
					{ type: "message_start", message: { role: "assistant" } },
					{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first draft " } },
					{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first draft" }], usage: {} } },
					{ type: "message_start", message: { role: "assistant" } },
					{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second draft" } },
				],
				finalText: "second draft",
			},
			{ onProgress: (info) => seen.push({ preview: info.preview }) },
		);
		assert.equal(r.status, "completed");
		if (r.status === "completed") assert.equal(r.output, "second draft");
		const previews = seen.map((s) => s.preview).filter((p): p is string => p !== undefined);
		assert.ok(previews.some((p) => p.startsWith("first draft")));
		// After the second message_start the preview restarts from scratch.
		const idx = previews.findIndex((p) => p === "second draft");
		assert.ok(idx > 0, `previews: ${JSON.stringify(previews)}`);
		assert.ok(!previews[idx].includes("first draft"));
	});

	it("bounds the preview within the live-preview budget and stays UTF-8 safe", async () => {
		const { truncateTailUtf8 } = await import("./reviewer-runner.ts");
		// 3-byte characters straddling the tail boundary must not split.
		const text = `x${"語".repeat(200)}`; // 1 + 600 bytes
		const tail = truncateTailUtf8(text, 100);
		assert.ok(Buffer.byteLength(tail, "utf8") <= 100);
		assert.ok(!tail.includes("�"));
		assert.equal(tail, "語".repeat(33)); // 33 × 3 = 99 bytes

		const previews: string[] = [];
		const events = [];
		for (let i = 0; i < 20; i++) {
			events.push({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: `${i}:` + "語".repeat(30) },
			});
		}
		const r = await run(
			{ events, finalText: "done" },
			{ onProgress: (info) => info.preview !== undefined && previews.push(info.preview) },
		);
		assert.equal(r.status, "completed");
		const lastStreamed = previews.at(-1);
		assert.ok(lastStreamed);
		assert.ok(Buffer.byteLength(lastStreamed, "utf8") <= 240);
		assert.ok(!lastStreamed.includes("�"));
		// message_end reconciles to the final short text.
		if (r.status === "completed") assert.equal(r.output, "done");
	});
});
