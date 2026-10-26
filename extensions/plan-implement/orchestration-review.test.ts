import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
	type AgentHost,
	type AskOptions,
	type AskResult,
	type HostedAgent,
	type HostedAgentSpec,
	openPaneHost,
} from "../shared/herdr/agent-host.ts";
import { createAdversaryReview, disposeReviewWorkflow } from "./orchestration.ts";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

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
	readonly exchangeDir: string;
	readonly specs: HostedAgentSpec[] = [];
	readonly disposals: Array<Parameters<AgentHost["dispose"]>[0]> = [];
	agent: HostedAgent = new RecordingAgent();
	constructor(exchangeDir: string) {
		this.exchangeDir = exchangeDir;
	}
	async start(spec: HostedAgentSpec): Promise<{ ok: true; agent: HostedAgent }> {
		this.specs.push(spec);
		return { ok: true, agent: this.agent };
	}
	async dispose(options?: Parameters<AgentHost["dispose"]>[0]): Promise<void> {
		this.disposals.push(options);
	}
}

function createFixture(t: TestContext, open?: (host: RecordingHost) => ReturnType<typeof openPaneHost>) {
	const previous = process.env.HERDR_ENV;
	delete process.env.HERDR_ENV;
	const root = mkdtempSync(join(tmpdir(), "kstack-review-"));
	t.after(() => {
		if (previous === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const createHost = () => new RecordingHost(mkdtempSync(join(root, "host-")));
	const host = createHost();
	const systemPromptFile = join(root, "prompt.md");
	writeFileSync(systemPromptFile, "review prompt\n");
	const request = {
		adversaries: [{ label: "adversary-1", model: "test/model" }],
		cwd: "/repo",
		taskFile: "/task",
		planFile: "/plan",
		ledgerFile: "/ledger",
		diffFile: "/diff",
		systemPromptFile,
		timeoutMs: 60_000,
	};
	const review = createAdversaryReview({
		openPane: () => (open ? open(host) : Promise.resolve({ ok: true, host })),
		createExec: () => async () => ({ code: 0, stdout: "", stderr: "" }),
		notify: () => {},
		onStarted: () => {},
		onBlocked: async () => false,
		label: "test",
	});
	return { host, review, request, createHost };
}

describe("createAdversaryReview", { concurrency: false }, () => {
	it("reports real hosted preflight failure for direct use outside Herdr without spawning a child", async () => {
		const notices: string[] = [];
		const review = createAdversaryReview({
			openPane: (options, deps) => openPaneHost(options, { ...deps, env: {} }),
			createExec: () => async () => {
				throw new Error("must refuse before executing Herdr");
			},
			notify: (message) => notices.push(message),
			onStarted: () => assert.fail("must not start an adversary"),
			onBlocked: async () => false,
			label: "test",
		});
		try {
			const results = await review.run({
				adversaries: [{ label: "adversary-1", model: "test/adversary" }],
				cwd: "/repo",
				taskFile: "/task.md",
				planFile: "/plan.md",
				ledgerFile: "/ledger.md",
				diffFile: "/diff",
				systemPromptFile: "/prompt.md",
				timeoutMs: 1000,
			});
			assert.equal(results[0]?.status, "failed");
			assert.match(notices.join("\n"), /Herdr is required/);
		} finally {
			await review.dispose();
		}
	});
	it("finishes the workflow and primary runner when late review cleanup fails", async (t) => {
		const opening = deferred();
		const entered = deferred();
		const { review, request } = createFixture(t, async (host) => {
			host.dispose = async () => {
				throw new Error("late close refused");
			};
			entered.resolve();
			await opening.promise;
			return { ok: true, host };
		});
		const abort = new AbortController();
		const running = review.run({ ...request, signal: abort.signal });
		await entered.promise;
		abort.abort();
		await running;
		const events: string[] = [];
		const finishing = disposeReviewWorkflow({
			review,
			runner: {
				async dispose() {
					events.push("primary runner disposed");
				},
			},
			reportError: (message) => events.push(message),
			finish: () => events.push("workflow finished"),
		});
		opening.resolve();
		await finishing;
		assert.match(events[0] ?? "", /Review cleanup failed.*late close refused/);
		assert.deepEqual(events.slice(1), ["primary runner disposed", "workflow finished"]);
	});

	it("finishes the workflow even when primary runner teardown rejects", async () => {
		let finished = false;
		await assert.rejects(
			disposeReviewWorkflow({
				review: { async dispose() {} },
				runner: {
					async dispose() {
						throw new Error("primary teardown failed");
					},
				},
				reportError: () => {},
				finish: () => {
					finished = true;
				},
			}),
			/primary teardown failed/,
		);
		assert.equal(finished, true);
	});

	it("discards a cancelled runner, acquires fresh, reuses success, and joins active runs", async (t) => {
		let opens = 0;
		const {
			host: first,
			review,
			request,
			createHost,
		} = createFixture(t, async (host) => ({ ok: true, host: opens++ === 0 ? host : second }));
		const second = createHost();
		const askEntered = deferred();
		const askFinished = deferred();
		first.agent.ask = async (options: AskOptions) => {
			askEntered.resolve();
			await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
			await askFinished.promise;
			return { status: "aborted", usage };
		};
		const abort = new AbortController();
		const running = review.run({ ...request, signal: abort.signal });
		await askEntered.promise;
		abort.abort();
		askFinished.resolve();
		assert.equal((await running)[0]?.status, "aborted");
		assert.equal((await review.run(request))[0]?.status, "completed");
		assert.equal((await review.run(request))[0]?.status, "completed");
		assert.equal(opens, 2);
		assert.equal(second.specs.length, 1);
		const entered = deferred();
		const release = deferred();
		second.agent.ask = async () => {
			entered.resolve();
			await release.promise;
			return { status: "completed", output: "approve", usage };
		};
		const last = review.run(request);
		await entered.promise;
		const disposing = review.dispose();
		assert.equal(review.dispose(), disposing);
		let done = false;
		void disposing.then(() => {
			done = true;
		});
		await Promise.resolve();
		assert.equal(done, false);
		assert.deepEqual(second.disposals, []);
		release.resolve();
		await last;
		await disposing;
		assert.deepEqual(first.disposals, [{ closeTab: true }]);
		// Disposal joins a running round without changing successful retention.
		assert.deepEqual(second.disposals, [undefined]);
		assert.equal((await review.run(request))[0]?.status, "failed");
	});

	it("bounds hosted setup without HERDR_ENV and still disposes the late host", async (t) => {
		const opening = deferred();
		const entered = deferred();
		const teardown = deferred();
		const { host, review, request } = createFixture(t, async (host) => {
			host.dispose = async (options) => {
				await teardown.promise;
				host.disposals.push(options);
			};
			entered.resolve();
			await opening.promise;
			return { ok: true, host };
		});
		const abort = new AbortController();
		const running = review.run({ ...request, signal: abort.signal });
		await entered.promise;
		abort.abort();
		const results = await running;
		assert.equal(results.length, 1);
		assert.equal(results[0]?.status, "failed");
		if (results[0]?.status === "failed") assert.match(results[0].error, /deadline/);
		assert.deepEqual(host.disposals, []);
		let finished = false;
		const disposing = review.dispose().then(() => {
			finished = true;
		});
		await Promise.resolve();
		assert.equal(finished, false);
		opening.resolve();
		teardown.resolve();
		await disposing;
		assert.deepEqual(host.disposals, [{ closeTab: true }]);
		assert.equal(host.specs.length, 0);
	});

	it("appends the planning-session reference to a pane adversary's system prompts", async (t) => {
		const { host, review, request } = createFixture(t);
		const reference = join(host.exchangeDir, "planning-session.md");
		writeFileSync(reference, "planning reference\n");
		const results = await review.run({ ...request, extraSystemPromptFiles: [reference] });
		assert.equal(results[0]?.status, "completed");
		assert.equal(host.specs.length, 1);
		assert.equal(host.specs[0]?.systemPromptFiles?.at(-2), reference);
		assert.match(host.specs[0]?.systemPromptFiles?.at(-1) ?? "", /\/read-only\.md$/);
		await review.dispose();
		assert.deepEqual(host.disposals, [undefined]);
	});
});
