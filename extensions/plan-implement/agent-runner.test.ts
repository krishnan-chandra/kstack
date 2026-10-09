import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentHost, AskOptions, AskResult, HostedAgent, HostedAgentSpec } from "../shared/herdr/agent-host.ts";
import { buildRoleInstructions, buildRoleSpec, createRoleRunner, type RunAgentOptions } from "./agent-runner.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 };

class FakeAgent implements HostedAgent {
	readonly name: string;
	readonly role: string;
	readonly paneId: string;
	readonly tabId = "w1:t1";
	readonly sessionFile: string | undefined;
	asks: AskOptions[] = [];
	resumes: number = 0;
	results: AskResult[] = [];
	resumeResults: AskResult[] = [];
	abortCalls = 0;
	askGate: Promise<void> | undefined;

	constructor(role: string, identity: string = role) {
		this.role = role;
		this.name = `plan-${role}-abcd`;
		this.paneId = `w1:p-${identity}`;
		this.sessionFile = `/sessions/${role}.jsonl`;
	}

	async ask(options: AskOptions): Promise<AskResult> {
		this.asks.push(options);
		if (this.askGate) await this.askGate;
		return (
			this.results.shift() ?? { status: "completed", output: `${this.role} output`, usage, session: this.sessionFile }
		);
	}

	async resume(): Promise<AskResult> {
		this.resumes++;
		if (this.abortCalls > 0) return { status: "aborted", usage };
		return this.resumeResults.shift() ?? { status: "completed", output: `${this.role} resumed`, usage };
	}

	async abort(): Promise<void> {
		this.abortCalls++;
	}

	async dispose(): Promise<void> {}
}

class FakeHost implements AgentHost {
	readonly tabId = "w1:t1";
	readonly exchangeDir = mkdtempSync(join(tmpdir(), "kstack-role-runner-"));
	readonly specs: HostedAgentSpec[] = [];
	readonly agents = new Map<string, FakeAgent>();
	nextAskGate: Promise<void> | undefined;
	disposeArgs: Array<{ closeTab?: boolean } | undefined> = [];

	async start(spec: HostedAgentSpec) {
		this.specs.push(spec);
		const identity = spec.sessionName ?? spec.role;
		const agent = new FakeAgent(spec.role, identity);
		agent.askGate = this.nextAskGate;
		this.agents.set(identity, agent);
		return { ok: true as const, agent };
	}

	async dispose(options?: { closeTab?: boolean }): Promise<void> {
		this.disposeArgs.push(options);
	}
}

function roleOptions(role: RunAgentOptions["role"] = "planner"): RunAgentOptions {
	const dir = mkdtempSync(join(tmpdir(), "kstack-role-options-"));
	const promptFile = join(dir, `${role}.md`);
	const taskFile = join(dir, "task.md");
	writeFileSync(promptFile, `system for ${role}\n`);
	writeFileSync(taskFile, "task\n");
	return {
		role,
		model: role === "planner" ? "a/planner:high" : "b/worker:medium",
		promptFile,
		taskFile,
		planFile: join(dir, "plan.md"),
		ledgerFile: join(dir, "ledger.md"),
		verdictFile: join(dir, "verdict.md"),
		cwd: "/repo",
		timeoutMs: 60_000,
	};
}

describe("role contract builders", () => {
	it("enables discovery and a read-only system prompt for planner and adversary", () => {
		const planner = roleOptions("planner");
		const plannerSpec = buildRoleSpec(planner, "/tmp/system.md");
		assert.equal(plannerSpec.tools, undefined);
		assert.equal(plannerSpec.inheritExtensions, true);
		assert.equal(plannerSpec.sessionName, "plan-implement/planner");
		const adversarySpec = buildRoleSpec(roleOptions("adversary"), "/tmp/system.md");
		assert.equal(adversarySpec.tools, undefined);
		assert.equal(adversarySpec.inheritExtensions, true);
		for (const spec of [plannerSpec, adversarySpec]) {
			assert.ok(spec.systemPromptFiles?.some((file) => file.endsWith("/read-only.md")));
		}
		const implementer = buildRoleSpec(roleOptions("implementer"), "/tmp/system.md");
		assert.equal(
			implementer.systemPromptFiles?.some((file) => file.endsWith("/read-only.md")),
			false,
		);
	});

	it("disables discovery and re-adds selected skills in stack mode", () => {
		const options = { ...roleOptions("implementer"), mode: "stack" as const, skillPaths: ["/skills/tdd"] };
		const spec = buildRoleSpec(options, "/tmp/system.md");
		assert.equal(spec.inheritExtensions, true);
		assert.equal(spec.noSkills, true);
		assert.deepEqual(spec.skillPaths, ["/skills/tdd"]);
	});

	it("appends extra system prompt files after the combined role prompt", () => {
		const options = { ...roleOptions("implementer"), extraSystemPromptFiles: ["/run/planning-session.md"] };
		const spec = buildRoleSpec(options, "/tmp/system.md");
		assert.deepEqual(spec.systemPromptFiles, ["/tmp/system.md", "/run/planning-session.md"]);
	});

	it("keeps large content behind file pointers", () => {
		const planner = buildRoleInstructions(roleOptions("planner"));
		assert.match(planner, /Read the user task at/);
		const implementer = buildRoleInstructions(roleOptions("implementer"));
		assert.match(implementer, /approved plan at/);
		assert.match(implementer, /execution ledger at/);
		const fixer = buildRoleInstructions(roleOptions("fixer"));
		assert.match(fixer, /adversarial review verdict at/);
	});
});

describe("createRoleRunner", () => {
	it("starts each role once and reuses it across asks", async () => {
		const host = new FakeHost();
		const runner = createRoleRunner(host);
		const first = await runner.run(roleOptions("planner"));
		const second = await runner.run({ ...roleOptions("planner"), instructions: "Revise the prior plan." });
		assert.equal(first.status, "completed");
		assert.equal(second.status, "completed");
		assert.equal(host.specs.length, 1);
		assert.equal(host.agents.get("plan-implement/planner")?.asks.length, 2);
	});

	it("maps output, usage, and session path", async () => {
		const host = new FakeHost();
		const runner = createRoleRunner(host);
		const result = await runner.run(roleOptions("planner"));
		assert.deepEqual(result, {
			status: "completed",
			role: "planner",
			model: "a/planner:high",
			output: "planner output",
			usage,
			session: "/sessions/planner.jsonl",
		});
	});

	it("surfaces blocked agents or resumes them after confirmation", async () => {
		const host = new FakeHost();
		const runner = createRoleRunner(host, {
			onBlocked: async (role, paneId) => {
				assert.equal(role, "planner");
				assert.equal(paneId, "w1:p-plan-implement/planner");
				return true;
			},
		});
		const pending = runner.run(roleOptions("planner"));
		const agent = host.agents.get("plan-implement/planner");
		assert.ok(agent);
		agent.results.push({ status: "blocked", paneId: agent.paneId, usage });
		agent.resumeResults.push({ status: "completed", output: "revised", usage });
		const result = await pending;
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.deepEqual(result.usage, { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2 });
		}
		assert.equal(agent.resumes, 1);
	});

	it("settles a declined blocked request through the host so the role stays usable", async () => {
		const host = new FakeHost();
		const runner = createRoleRunner(host, { onBlocked: async () => false });
		const pending = runner.run(roleOptions("planner"));
		const agent = host.agents.get("plan-implement/planner");
		assert.ok(agent);
		agent.results.push({ status: "blocked", paneId: agent.paneId, usage });
		const result = await pending;
		assert.equal(result.status, "aborted");
		assert.equal(agent.abortCalls, 1);
		// The host releases a blocked request only when the caller resumes it after cancelling.
		assert.equal(agent.resumes, 1);
		assert.equal((await runner.run(roleOptions("planner"))).status, "completed");
	});

	it("aborts an active ask and disposes without closing the retained tab", async () => {
		const host = new FakeHost();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		host.nextAskGate = gate;
		const runner = createRoleRunner(host);
		const pending = runner.run(roleOptions("implementer"));
		await Promise.resolve();
		await Promise.resolve();
		const agent = host.agents.get("plan-implement/implementer");
		assert.ok(agent);
		assert.equal(await runner.abortActive(), true);
		assert.equal(agent.abortCalls, 1);
		release?.();
		await pending;
		await runner.dispose();
		await runner.dispose();
		assert.deepEqual(host.disposeArgs, [undefined]);
	});

	it("rejects attempts to change an existing role's model", async () => {
		const host = new FakeHost();
		const runner = createRoleRunner(host);
		await runner.run(roleOptions("planner"));
		const result = await runner.run({ ...roleOptions("planner"), model: "other/model" });
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /different model or cwd/);
	});

	it("starts independent instances of the same role under distinct sessions", async () => {
		const host = new FakeHost();
		const runner = createRoleRunner(host);
		const first = await runner.run({ ...roleOptions("adversary"), instance: "a", model: "openai/astra:medium" });
		const second = await runner.run({ ...roleOptions("adversary"), instance: "b", model: "openai/terra:medium" });
		assert.equal(first.status, "completed");
		assert.equal(second.status, "completed");
		assert.equal(host.specs.length, 2);
		assert.deepEqual(
			host.specs.map((spec) => spec.sessionName),
			["plan-implement/adversary-a", "plan-implement/adversary-b"],
		);
		assert.equal(runner.paneId("adversary", "a"), "w1:p-plan-implement/adversary-a");
		assert.equal(runner.paneId("adversary", "b"), "w1:p-plan-implement/adversary-b");
		// Re-asking an instance reuses its session rather than starting a third agent.
		await runner.run({ ...roleOptions("adversary"), instance: "a", model: "openai/astra:medium" });
		assert.equal(host.specs.length, 2);
		assert.equal(host.agents.get("plan-implement/adversary-a")?.asks.length, 2);
	});

	it("does not start a queued role whose deadline already fired", async () => {
		const host = new FakeHost();
		const runner = createRoleRunner(host);
		const controller = new AbortController();
		controller.abort();
		const result = await runner.run({
			...roleOptions("adversary"),
			instance: "1",
			model: "openai/astra:medium",
			signal: controller.signal,
		});
		assert.equal(result.status, "aborted");
		assert.equal(host.specs.length, 0);
	});
});
