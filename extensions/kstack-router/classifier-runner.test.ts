import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { buildClassifierChildArgs, runClassifier, type SpawnedProcess } from "./classifier-runner.ts";
import { CLASSIFIER_SENTINEL_END, CLASSIFIER_SENTINEL_START } from "./types.ts";

const ENVELOPE = `${CLASSIFIER_SENTINEL_START}\n{"schemaVersion":1,"route":"investigate","confidence":"high","rationale":"read-only question"}\n${CLASSIFIER_SENTINEL_END}`;

class FakeStdin {
	writes: string[] = [];
	ended = false;
	write(data: string): boolean {
		this.writes.push(data);
		return true;
	}
	end(): void {
		this.ended = true;
	}
}

class FakeProcess implements SpawnedProcess {
	stdin = new FakeStdin();
	stdout = new EventEmitter() as SpawnedProcess["stdout"] & EventEmitter;
	stderr = new EventEmitter() as SpawnedProcess["stderr"] & EventEmitter;
	private events = new EventEmitter();
	killed = false;
	kills: string[] = [];
	pid = 4242;
	on(event: "close" | "error", cb: (...args: any[]) => void): void {
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
	emitStdout(chunk: string): void {
		this.stdout.emit("data", Buffer.from(chunk, "utf8"));
	}
}

function assistantEvent(text: string, usage: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 10, output: 5, cost: { total: 0.001 }, ...usage },
		},
	})}\n`;
}

function options(process: FakeProcess, extra: Record<string, unknown> = {}) {
	return {
		model: "provider/model",
		task: "sensitive-task-content",
		killGraceMs: 5,
		timeoutSeconds: 60,
		spawnImpl: () => process,
		...extra,
	};
}

describe("buildClassifierChildArgs", () => {
	it("disables all discovery and tools", () => {
		const args = buildClassifierChildArgs("provider/model");
		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("--no-skills"));
		assert.ok(args.includes("--no-prompt-templates"));
		assert.ok(args.includes("--no-context-files"));
		assert.ok(args.includes("--no-tools"));
		assert.ok(args.includes("--no-approve"));
		assert.ok(args.includes("--no-session"));
		assert.ok(args.includes("--mode"));
		assert.ok(args.includes("json"));
		assert.ok(args.includes("-p"));
	});

	it("sets the model", () => {
		const args = buildClassifierChildArgs("custom/model");
		const modelIdx = args.indexOf("--model");
		assert.ok(modelIdx >= 0);
		assert.equal(args[modelIdx + 1], "custom/model");
	});

	it("points --append-system-prompt at the classifier prompt file", () => {
		const args = buildClassifierChildArgs("p/m");
		const idx = args.indexOf("--append-system-prompt");
		assert.ok(idx >= 0);
		assert.match(args[idx + 1], /prompts[\\/]classifier\.md$/);
	});

	it("honors a custom prompt file", () => {
		const args = buildClassifierChildArgs("p/m", { promptFile: "/tmp/custom.md" });
		const idx = args.indexOf("--append-system-prompt");
		assert.equal(args[idx + 1], "/tmp/custom.md");
	});

	it("passes --thinking only when configured", () => {
		const without = buildClassifierChildArgs("p/m");
		assert.ok(!without.includes("--thinking"));
		const withThinking = buildClassifierChildArgs("p/m", { thinking: "low" });
		const idx = withThinking.indexOf("--thinking");
		assert.ok(idx >= 0);
		assert.equal(withThinking[idx + 1], "low");
	});

	it("never places the task in argv", () => {
		const args = buildClassifierChildArgs("p/m");
		assert.ok(!args.join(" ").includes("sensitive-task-content"));
	});
});

describe("runClassifier", () => {
	it("pipes the task over stdin and parses the JSONL assistant envelope", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		assert.deepEqual(process.stdin.writes, ["sensitive-task-content"]);
		assert.equal(process.stdin.ended, true);

		process.emitStdout(assistantEvent(ENVELOPE));
		process.close(0);
		const result = await promise;
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.equal(result.envelope.route, "investigate");
			assert.equal(result.usage.input, 10);
			assert.equal(result.usage.turns, 1);
		}
	});

	it("parses JSONL events split across chunk boundaries", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		const line = assistantEvent(ENVELOPE);
		// Split mid-line and mid-multibyte-safe boundary.
		process.emitStdout(line.slice(0, 40));
		process.emitStdout(line.slice(40));
		process.close(0);
		const result = await promise;
		assert.equal(result.status, "completed");
	});

	it("ignores non-assistant and malformed JSONL lines", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		process.emitStdout('{"type":"turn_start"}\nnot-json\n');
		process.emitStdout(`${JSON.stringify({ type: "message_end", message: { role: "toolResult" } })}\n`);
		process.emitStdout(assistantEvent(ENVELOPE));
		process.close(0);
		const result = await promise;
		assert.equal(result.status, "completed");
	});

	it("fails when the assistant text has no valid envelope", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		process.emitStdout(assistantEvent("I could not classify this."));
		process.close(0);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /sentinel/);
	});

	it("fails when the child produces no assistant output", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		process.close(0);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /no assistant output/);
	});

	it("surfaces model errorMessage from message_end events", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		process.emitStdout(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", errorMessage: "provider quota exceeded", content: [] },
			})}\n`,
		);
		process.close(0);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /quota exceeded/);
	});

	it("reports non-zero exit codes", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		process.emitStdout(assistantEvent(ENVELOPE));
		process.close(1);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /code 1/);
	});

	it("reports synchronous spawn failures", async () => {
		const result = await runClassifier(
			options(new FakeProcess(), {
				spawnImpl: () => {
					throw new Error("spawn denied");
				},
			}),
		);
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /spawn denied/);
	});

	it("reports asynchronous spawn errors", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process));
		process.error(new Error("child_process error"));
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /child_process error/);
	});

	it("aborts via SIGTERM and reports aborted", async () => {
		const process = new FakeProcess();
		const controller = new AbortController();
		const promise = runClassifier(options(process, { signal: controller.signal }));
		controller.abort();
		assert.ok(process.kills.includes("SIGTERM"));
		process.close(null);
		const result = await promise;
		assert.equal(result.status, "aborted");
	});

	it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		const process = new FakeProcess();
		const controller = new AbortController();
		const promise = runClassifier(options(process, { signal: controller.signal, killGraceMs: 5 }));
		controller.abort();
		await new Promise((r) => setTimeout(r, 25));
		assert.deepEqual(process.kills, ["SIGTERM", "SIGKILL"]);
		process.close(null);
		const result = await promise;
		assert.equal(result.status, "aborted");
	});

	it("times out and escalates", async () => {
		const process = new FakeProcess();
		const promise = runClassifier(options(process, { timeoutSeconds: 0.01, killGraceMs: 5 }));
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(process.kills.includes("SIGTERM"));
		assert.ok(process.kills.includes("SIGKILL"));
		process.close(null);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /timed out/);
	});
});
