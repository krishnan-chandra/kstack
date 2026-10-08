import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentHost, HostedAgent, HostedAgentSpec } from "../shared/herdr/agent-host.ts";
import { createAdversaryReview } from "./orchestration.ts";

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
});
