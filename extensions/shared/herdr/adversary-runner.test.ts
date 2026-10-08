import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type {
	ChildRunnerDeps,
	ProcessGroupSystem,
	SpawnedProcess,
	SpawnImpl,
	SubagentSessionStore,
} from "../child-agent-runner.ts";
import {
	type HeadlessAdversaryOptions,
	headlessAdversaryArgs,
	runHeadlessAdversary,
	selectAdversaryTransport,
} from "./adversary-runner.ts";

describe("selectAdversaryTransport", () => {
	it("uses a pane inside Herdr and a headless child otherwise", () => {
		assert.equal(selectAdversaryTransport({ HERDR_ENV: "1" }), "pane");
		assert.equal(selectAdversaryTransport({}), "headless");
		assert.equal(selectAdversaryTransport({ HERDR_ENV: "0" }), "headless");
	});
});

describe("headlessAdversaryArgs", () => {
	it("runs one isolated read-only adversary with the configured model and system prompt", () => {
		const args = headlessAdversaryArgs({
			model: "openai/gpt-6-astra:medium",
			systemPromptFile: "/tmp/adversary.md",
		});
		assert.ok(args.includes("--no-skills"));
		assert.ok(args.includes("--no-context-files"));
		assert.ok(args.includes("-p"));
		const pair = (flag: string) => args.slice(args.indexOf(flag), args.indexOf(flag) + 2);
		assert.deepEqual(pair("--tools"), ["--tools", "read,grep,find,ls"]);
		assert.deepEqual(pair("--model"), ["--model", "openai/gpt-6-astra:medium"]);
		assert.deepEqual(pair("--append-system-prompt"), ["--append-system-prompt", "/tmp/adversary.md"]);
	});
});

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const sessionStore: SubagentSessionStore = {
	prepare: (_identity, cwd) => ({
		ok: true,
		prepared: {
			id: SESSION_ID,
			name: "adversary/astra",
			root: "/sessions",
			expectedCwd: cwd,
			cliArgs: ["--session-id", SESSION_ID],
			leaseFile: "/sessions/.active/test.json",
		},
	}),
	markSpawned: () => ({ ok: true }),
	finish: (prepared) => ({ kind: "persisted", id: prepared.id, name: prepared.name, file: "/sessions/test.jsonl" }),
};

class FakeStdin extends EventEmitter {
	readonly writes: string[] = [];
	ended = false;
	write(data: string): boolean {
		this.writes.push(data);
		return true;
	}
	end(): void {
		this.ended = true;
	}
}

/** Minimal scripted Pi child: emits a session header, then one assistant answer. */
class FakeProcess implements SpawnedProcess {
	readonly stdin = new FakeStdin();
	readonly stdout =
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ new EventEmitter() as SpawnedProcess["stdout"] &
			EventEmitter;
	readonly stderr =
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ new EventEmitter() as SpawnedProcess["stderr"] &
			EventEmitter;
	private readonly events = new EventEmitter();
	killed = false;
	pid = 4242;
	on(event: "close", cb: (code: number | null) => void): void;
	on(event: "error", cb: (error: Error) => void): void;
	on(event: "close" | "error", cb: ((code: number | null) => void) | ((error: Error) => void)): void {
		this.events.on(event, cb);
	}
	kill(): boolean {
		this.killed = true;
		return true;
	}
	close(code: number | null): void {
		this.events.emit("close", code);
	}
	emitHeader(): void {
		this.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" })}\n`,
			),
		);
	}
	emitAnswer(text: string): void {
		this.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				})}\n`,
			),
		);
	}
}

const OPTIONS: HeadlessAdversaryOptions = {
	model: "openai/gpt-6-astra:medium",
	cwd: "/repo",
	prompt: "review the diff",
	systemPromptFile: "/tmp/adversary.md",
	owner: "adversary",
	label: "astra",
	timeoutMs: 60_000,
};

function deps(child: FakeProcess, extra: ChildRunnerDeps = {}): ChildRunnerDeps {
	return {
		spawnImpl: () => child,
		piInvocation: (args) => ({ command: "pi", args }),
		sessionStore,
		...extra,
	};
}

describe("runHeadlessAdversary", () => {
	it("returns the child's answer and delivers the prompt on stdin", async () => {
		const child = new FakeProcess();
		const promise = runHeadlessAdversary(OPTIONS, deps(child));
		await new Promise((resolve) => setTimeout(resolve, 0));
		child.emitHeader();
		child.emitAnswer("Verdict: approve");
		child.close(0);
		const result = await promise;
		assert.equal(result.status, "completed");
		if (result.status === "completed") assert.match(result.output, /Verdict: approve/);
		assert.equal(child.stdin.writes.join(""), "review the diff");
		assert.equal(child.stdin.ended, true);
	});

	it("maps a spawn failure to a failed review result", async () => {
		const spawnImpl: SpawnImpl = () => {
			throw new Error("boom");
		};
		const result = await runHeadlessAdversary(OPTIONS, {
			spawnImpl,
			piInvocation: (args) => ({ command: "pi", args }),
			sessionStore,
		});
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /Spawn failed/);
	});

	it("preserves a process-group cleanup failure on cancellation", async () => {
		const child = new FakeProcess();
		const groupSystem: ProcessGroupSystem = {
			killGroup: () => {
				throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
			},
		};
		const controller = new AbortController();
		const promise = runHeadlessAdversary(
			{ ...OPTIONS, signal: controller.signal },
			deps(child, { processGroupSystem: groupSystem }),
		);
		controller.abort();
		const result = await promise;
		assert.equal(result.status, "aborted");
		assert.match(result.cleanupError ?? "", /Operation not permitted/);
	});
});
