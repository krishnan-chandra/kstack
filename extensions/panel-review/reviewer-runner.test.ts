import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildArgs, JsonLineParser, runReviewer, summarizeToolCall, type SpawnImpl } from "./reviewer-runner.ts";
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

	it("times out: SIGTERM then SIGKILL, result is failed with timeout error", async () => {
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
		if (r.status === "failed") assert.match(r.error, /Timed out after/);
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
