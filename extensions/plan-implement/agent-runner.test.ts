import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { JsonLineParser } from "../shared/pi-json-lines.ts";
import { buildChildArgs, runAgent, truncateUtf8, type SpawnedProcess } from "./agent-runner.ts";

class FakeProcess implements SpawnedProcess {
	stdout = new EventEmitter() as SpawnedProcess["stdout"] & EventEmitter;
	stderr = new EventEmitter() as SpawnedProcess["stderr"] & EventEmitter;
	private events = new EventEmitter();
	killed = false;
	kills: string[] = [];
	on(event: "close" | "error", cb: (...args: any[]) => void): void { this.events.on(event, cb); }
	kill(signal = "SIGTERM"): boolean { this.killed = true; this.kills.push(signal); return true; }
	close(code: number | null): void { this.events.emit("close", code); }
	error(error: Error): void { this.events.emit("error", error); }
}

function options(process: FakeProcess, extra: Record<string, unknown> = {}) {
	return {
		role: "planner" as const,
		model: "a/planner:high",
		promptFile: "/tmp/planner.md",
		taskFile: "/tmp/task.md",
		cwd: "/repo",
		deps: {
			spawnImpl: () => process,
			piInvocation: (args: string[]) => ({ command: "pi", args }),
			killGraceMs: 5,
			timeoutMs: 1000,
		},
		...extra,
	};
}

describe("plan-implement child runner", () => {
	it("keeps skills/context enabled, restricts planner tools, and leaves implementer tools normal", () => {
		const planner = buildChildArgs({ role: "planner", model: "a/p", promptFile: "/p", taskFile: "/t" });
		assert.ok(planner.includes("--no-extensions"));
		assert.ok(planner.includes("--no-prompt-templates"));
		assert.ok(!planner.includes("--no-skills"));
		assert.ok(!planner.includes("--no-context-files"));
		assert.deepEqual(planner.slice(planner.indexOf("--tools"), planner.indexOf("--tools") + 2), ["--tools", "read,grep,find,ls"]);
		assert.match(planner.at(-1) ?? "", /single-PR/);

		const implementer = buildChildArgs({ role: "implementer", model: "b/i", promptFile: "/p", taskFile: "/t", planFile: "/plan" });
		assert.ok(!implementer.includes("--tools"));
		assert.match(implementer.at(-1) ?? "", /approved plan at \/plan/);
	});

	it("appends the selected proof-obligation playbook to each child role", () => {
		const prompt = "# Bug-fix proof obligations\nReproduce first.";
		for (const role of ["planner", "implementer"] as const) {
			const args = buildChildArgs({
				role,
				model: "a/model",
				promptFile: "/role.md",
				taskFile: "/task.md",
				planFile: role === "implementer" ? "/plan.md" : undefined,
				playbookPrompt: prompt,
			});
			const promptFlags = args.reduce<number[]>((indices, value, index) => value === "--append-system-prompt" ? [...indices, index] : indices, []);
			assert.equal(promptFlags.length, 2);
			assert.equal(args[promptFlags[1] + 1], prompt);
		}
	});

	it("stack mode disables skill discovery and re-adds every provided skill except arena", () => {
		const skillPaths = ["/skills/create-skill", "/skills/find-reviewers", "/skills/jj-stacked-prs"];
		const planner = buildChildArgs({ role: "planner", model: "a/p", promptFile: "/p", taskFile: "/t", mode: "stack", skillPaths });
		const noSkillsAt = planner.indexOf("--no-skills");
		assert.ok(noSkillsAt !== -1, "planner disables skill discovery");
		// Every skill path is re-added after --no-skills.
		for (const path of skillPaths) {
			const skillAt = planner.indexOf("--skill");
			assert.ok(skillAt > noSkillsAt, "--skill comes after --no-skills");
			assert.ok(planner.includes(path), `planner re-adds ${path}`);
		}
		// Order: --no-skills immediately followed by the first --skill.
		assert.equal(planner[noSkillsAt + 1], "--skill");
		assert.match(planner.at(-1) ?? "", /stacked-PR/);

		const implementer = buildChildArgs({ role: "implementer", model: "b/i", promptFile: "/p", taskFile: "/t", planFile: "/plan", mode: "stack", skillPaths });
		assert.ok(implementer.includes("--no-skills"));
		for (const path of skillPaths) assert.ok(implementer.includes(path));
		assert.match(implementer.at(-1) ?? "", /stacked-PR delivery/);
	});

	it("stack mode with no skill paths still disables discovery", () => {
		const planner = buildChildArgs({ role: "planner", model: "a/p", promptFile: "/p", taskFile: "/t", mode: "stack" });
		assert.ok(planner.includes("--no-skills"));
		assert.ok(!planner.includes("--skill"));
	});

	it("fixer and publisher reference the verdict file and keep full tools", () => {
		const fixer = buildChildArgs({ role: "fixer", model: "a/i", promptFile: "/p", taskFile: "/t", verdictFile: "/v" });
		assert.ok(!fixer.includes("--tools"));
		assert.match(fixer.at(-1) ?? "", /panel-review verdict at \/v/);
		assert.match(fixer.at(-1) ?? "", /address the actionable findings/);
		assert.ok(!fixer.includes("/plan"));

		const publisher = buildChildArgs({ role: "publisher", model: "a/i", promptFile: "/p", taskFile: "/t", verdictFile: "/v" });
		assert.ok(!publisher.includes("--tools"));
		assert.match(publisher.at(-1) ?? "", /panel-review verdict at \/v/);
		assert.match(publisher.at(-1) ?? "", /draft pull request/);
		assert.match(publisher.at(-1) ?? "", /write-pr and find-reviewers/);
	});

	it("fixer and publisher get stack-mode notes and re-added skills in stack mode", () => {
		const skillPaths = ["/skills/write-pr", "/skills/find-reviewers", "/skills/jj-stacked-prs"];
		const fixer = buildChildArgs({ role: "fixer", model: "a/i", promptFile: "/p", taskFile: "/t", verdictFile: "/v", mode: "stack", skillPaths });
		assert.ok(fixer.includes("--no-skills"));
		for (const path of skillPaths) assert.ok(fixer.includes(path));
		assert.match(fixer.at(-1) ?? "", /amend the local stack/);

		const publisher = buildChildArgs({ role: "publisher", model: "a/i", promptFile: "/p", taskFile: "/t", verdictFile: "/v", mode: "stack", skillPaths });
		assert.match(publisher.at(-1) ?? "", /jj-stacked-prs skill for publishing the local stack/);
	});

	it("parses JSON lines across chunks and ignores malformed lines", () => {
		const seen: string[] = [];
		const parser = new JsonLineParser((event) => seen.push(event.type ?? ""));
		parser.push('{"type":"one"}\nnot-json\n{"type":');
		parser.push('"two"}\n');
		parser.flush();
		assert.deepEqual(seen, ["one", "two"]);
	});

	it("decodes UTF-8 split across buffer chunks", () => {
		let text: string | undefined;
		const parser = new JsonLineParser((event) => {
			text = event.message?.content?.[0]?.text;
		});
		const line = Buffer.from('{"type":"message_end","message":{"content":[{"type":"text","text":"café"}]}}\n');
		const split = line.indexOf(Buffer.from("é")) + 1;
		parser.push(line.subarray(0, split));
		parser.push(line.subarray(split));
		assert.equal(text, "café");
	});

	it("bounds partial stdout lines and resynchronizes after the newline", () => {
		const seen: string[] = [];
		let overflows = 0;
		const parser = new JsonLineParser((event) => seen.push(event.type ?? ""), {
			maxLineBytes: 16,
			onOverflow: () => overflows++,
		});
		parser.push("12345678");
		parser.push('901234567890\n{"type":"ok"}\n');
		assert.equal(overflows, 1);
		assert.deepEqual(seen, ["ok"]);
	});

	it("reports synchronous spawn failures", async () => {
		const process = new FakeProcess();
		const result = await runAgent(options(process, {
			deps: {
				spawnImpl: () => { throw new Error("spawn denied"); },
				piInvocation: (args: string[]) => ({ command: "pi", args }),
			},
		}));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /spawn denied/);
	});

	it("reports asynchronous spawn errors", async () => {
		const process = new FakeProcess();
		const promise = runAgent(options(process));
		process.error(new Error("child_process error"));
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /child_process error/);
	});

	it("returns the final assistant output and usage", async () => {
		const process = new FakeProcess();
		const promise = runAgent(options(process));
		process.stdout.emit("data", Buffer.from(JSON.stringify({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final plan" }], usage: { input: 3, output: 4, cost: { total: 0.1 } } },
		}) + "\n"));
		process.close(0);
		const result = await promise;
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.equal(result.output, "final plan");
			assert.equal(result.usage.input, 3);
			assert.equal(result.usage.output, 4);
		}
	});

	it("reports nonzero exits and provider error stops with bounded diagnostics", async () => {
		const exited = new FakeProcess();
		const exitedPromise = runAgent(options(exited));
		exited.stderr.emit("data", Buffer.from("child failed"));
		exited.close(2);
		const exitResult = await exitedPromise;
		assert.equal(exitResult.status, "failed");
		if (exitResult.status === "failed") assert.equal(exitResult.error, "child failed");

		const provider = new FakeProcess();
		const providerPromise = runAgent(options(provider));
		provider.stdout.emit("data", Buffer.from(JSON.stringify({
			type: "message_end",
			message: { role: "assistant", stopReason: "error", errorMessage: "quota exceeded", content: [] },
		}) + "\n"));
		provider.close(0);
		const providerResult = await providerPromise;
		assert.equal(providerResult.status, "failed");
		if (providerResult.status === "failed") assert.equal(providerResult.error, "quota exceeded");
	});

	it("propagates abort and reports an aborted result", async () => {
		const process = new FakeProcess();
		const controller = new AbortController();
		const promise = runAgent(options(process, { signal: controller.signal }));
		controller.abort();
		assert.deepEqual(process.kills, ["SIGTERM"]);
		process.close(null);
		assert.equal((await promise).status, "aborted");
	});

	it("escalates an ignored abort to SIGKILL", async () => {
		const process = new FakeProcess();
		const controller = new AbortController();
		const promise = runAgent(options(process, { signal: controller.signal }));
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 15));
		assert.deepEqual(process.kills, ["SIGTERM", "SIGKILL"]);
		process.close(null);
		assert.equal((await promise).status, "aborted");
	});

	it("kills and reports timeout", async () => {
		const process = new FakeProcess();
		const promise = runAgent(options(process, { deps: { spawnImpl: () => process, piInvocation: (args: string[]) => ({ command: "pi", args }), timeoutMs: 5, killGraceMs: 100 } }));
		await new Promise((resolve) => setTimeout(resolve, 15));
		assert.deepEqual(process.kills, ["SIGTERM"]);
		process.close(null);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /Timed out/);
	});

	it("terminates a child whose JSONL line exceeds the stdout cap", async () => {
		const process = new FakeProcess();
		const promise = runAgent(options(process, {
			deps: {
				spawnImpl: () => process,
				piInvocation: (args: string[]) => ({ command: "pi", args }),
				timeoutMs: 1000,
				killGraceMs: 100,
				stdoutLineCapBytes: 16,
			},
		}));
		process.stdout.emit("data", Buffer.from("x".repeat(17)));
		assert.deepEqual(process.kills, ["SIGTERM"]);
		process.close(null);
		const result = await promise;
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /larger than 16 bytes/);
	});

	it("bounds UTF-8 output with disclosure", () => {
		const output = truncateUtf8("🙂".repeat(20), 17);
		assert.match(output, /truncated at 17 bytes/);
		assert.ok(!output.includes("�"));
	});
});
