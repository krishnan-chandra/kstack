import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentHost, AskResult, HostedAgent, HostedAgentSpec } from "../shared/herdr/agent-host.ts";
import { createAdversaryReview } from "./orchestration.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

/** A host that starts one working adversary and records the spec it received. */
class RecordingAgent implements HostedAgent {
	readonly name = "plan-adversary-1-abcd";
	readonly role = "adversary";
	readonly paneId = "w1:p1";
	readonly tabId = "w1:tHost";
	readonly sessionFile = "/sessions/adversary.jsonl";
	async ask(): Promise<AskResult> {
		return { status: "completed", output: "Verdict: approve", usage };
	}
	async resume(): Promise<AskResult> {
		return { status: "completed", output: "", usage };
	}
	async abort(): Promise<void> {}
	async dispose(): Promise<void> {}
}

class RecordingHost implements AgentHost {
	readonly tabId = "w1:tHost";
	readonly exchangeDir = mkdtempSync(join(tmpdir(), "kstack-review-host-"));
	readonly specs: HostedAgentSpec[] = [];
	async start(spec: HostedAgentSpec): Promise<{ ok: true; agent: HostedAgent }> {
		this.specs.push(spec);
		return { ok: true, agent: new RecordingAgent() };
	}
	async dispose(): Promise<void> {}
}

/** A host that only records disposal; the review never reaches `start`. */
class FakeLateHost implements AgentHost {
	readonly tabId = "w1:tHost";
	readonly exchangeDir = "/tmp/kstack-review-exchange";
	disposed = false;
	closeTab: boolean | undefined;
	start(_spec: HostedAgentSpec): Promise<{ ok: true; agent: HostedAgent } | { ok: false; error: string }> {
		return Promise.resolve({ ok: false, error: "start is not expected" });
	}
	dispose(options?: { closeTab?: boolean }): Promise<void> {
		this.closeTab = options?.closeTab;
		// Delay the host's own teardown so the test proves controller disposal waits for it.
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				this.disposed = true;
				resolve();
			}, 30);
		});
	}
}

describe("createAdversaryReview", () => {
	it("bounds transport setup with the shared deadline and still disposes the late host", async () => {
		const previous = process.env.HERDR_ENV;
		process.env.HERDR_ENV = "1";
		try {
			const host = new FakeLateHost();
			const review = createAdversaryReview({
				openPane: async () => {
					// Succeed after the deadline so `run` must not wait for transport setup.
					await new Promise((resolve) => setTimeout(resolve, 150));
					return { ok: true, host };
				},
				createExec: () => async () => ({ code: 0, stdout: "", stderr: "" }),
				notify: () => {},
				onStarted: () => {},
				onBlocked: async () => false,
				label: "test",
			});
			const results = await review.run({
				adversaries: [{ label: "adversary-1", model: "openai/astra:medium" }],
				cwd: "/repo",
				taskFile: "/run/task.md",
				planFile: "/run/plan.md",
				ledgerFile: "/run/ledger.md",
				diffFile: "/run/change.diff",
				systemPromptFile: "/prompts/implementation-adversary.md",
				timeoutMs: 20,
			});
			assert.equal(results.length, 1);
			assert.equal(results[0]?.status, "failed");
			if (results[0]?.status === "failed") assert.match(results[0].error, /deadline/);
			assert.equal(host.disposed, false);
			// Controller disposal waits for the late host to open and close its panes.
			await review.dispose();
			assert.equal(host.disposed, true);
			assert.equal(host.closeTab, true);
		} finally {
			if (previous === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previous;
		}
	});

	it("appends the planning-session reference to a pane adversary's system prompts", async () => {
		const previous = process.env.HERDR_ENV;
		process.env.HERDR_ENV = "1";
		try {
			const dir = mkdtempSync(join(tmpdir(), "kstack-review-"));
			const basePrompt = join(dir, "adversary.md");
			const reference = join(dir, "planning-session.md");
			writeFileSync(basePrompt, "review prompt\n");
			writeFileSync(reference, "planning reference\n");
			const host = new RecordingHost();
			const review = createAdversaryReview({
				openPane: async () => ({ ok: true, host }),
				createExec: () => async () => ({ code: 0, stdout: "", stderr: "" }),
				notify: () => {},
				onStarted: () => {},
				onBlocked: async () => false,
				label: "test",
			});
			const results = await review.run({
				adversaries: [{ label: "adversary-1", model: "openai/astra:medium" }],
				cwd: "/repo",
				taskFile: join(dir, "task.md"),
				planFile: join(dir, "plan.md"),
				ledgerFile: join(dir, "ledger.md"),
				diffFile: join(dir, "change.diff"),
				systemPromptFile: basePrompt,
				extraSystemPromptFiles: [reference],
				timeoutMs: 60_000,
			});
			assert.equal(results[0]?.status, "completed");
			assert.equal(host.specs.length, 1);
			assert.equal(host.specs[0]?.systemPromptFiles?.at(-2), reference);
			assert.match(host.specs[0]?.systemPromptFiles?.at(-1) ?? "", /\/read-only\.md$/);
			await review.dispose();
		} finally {
			if (previous === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previous;
		}
	});
});
