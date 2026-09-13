import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createFloorLedger, type FloorLedger } from "./floor-ledger.ts";
import { createFloorRuntime, parseCompletedOpenRouterMessage } from "./floor-runtime.ts";

const now = new Date("2026-09-07T12:00:00.000Z");
const scopes: string[] = [];

afterEach(async () => {
	await Promise.all(scopes.splice(0).map((scope) => rm(scope, { recursive: true, force: true })));
});

async function tempScope(): Promise<string> {
	const scope = await mkdtemp(join(tmpdir(), "openrouter-floor-runtime-"));
	scopes.push(scope);
	return scope;
}

function deferredLedger() {
	let release: () => void = () => {};
	let reject: (error: Error) => void = () => {};
	const pending = new Promise<void>((resolve, rejectPending) => {
		release = resolve;
		reject = rejectPending;
	});
	let queue = Promise.resolve();
	const ledger: FloorLedger = {
		processId: "p-test",
		append() {
			const result = queue.then(() => pending);
			queue = result.catch(() => {});
			return result;
		},
		async read() {
			return { events: [], scopeLabel: "working directory" };
		},
		async flush() {
			await queue;
		},
	};
	return { ledger, release, reject };
}

describe("parseCompletedOpenRouterMessage", () => {
	it("accepts finalized OpenRouter assistant messages and preserves only the response identity", () => {
		assert.deepEqual(
			parseCompletedOpenRouterMessage({
				role: "assistant",
				provider: "openrouter",
				stopReason: "stop",
				responseId: "gen-123",
				content: "sensitive response",
			}),
			{ responseId: "gen-123" },
		);
		assert.deepEqual(
			parseCompletedOpenRouterMessage({ role: "assistant", provider: "openrouter", stopReason: "stop" }),
			{ responseId: undefined },
		);
	});

	it("rejects other providers and unsuccessful or unfinished messages", () => {
		assert.equal(
			parseCompletedOpenRouterMessage({ role: "assistant", provider: "openai", stopReason: "stop" }),
			undefined,
		);
		assert.equal(
			parseCompletedOpenRouterMessage({ role: "assistant", provider: "openrouter", stopReason: "error" }),
			undefined,
		);
		assert.equal(
			parseCompletedOpenRouterMessage({ role: "assistant", provider: "openrouter", stopReason: "aborted" }),
			undefined,
		);
		assert.equal(
			parseCompletedOpenRouterMessage({ role: "assistant", provider: "openrouter", stopReason: "deferred" }),
			undefined,
		);
	});
});

describe("floor runtime", () => {
	it("returns a rewrite before its ledger append settles", async () => {
		const { ledger, release } = deferredLedger();
		const runtime = createFloorRuntime({ ledger, clock: { now: () => now } });

		const replacement = await runtime.rewrite(
			{ model: "openai/gpt-5.6-sol", messages: [] },
			{ provider: "openrouter", id: "openai/gpt-5.6-sol" },
			"scope",
		);

		assert.equal(replacement?.model, "openai/gpt-5.6-sol:floor");
		release();
		await runtime.flush();
	});

	it("waits for a detached rewrite append during flush", async () => {
		const { ledger, release } = deferredLedger();
		const runtime = createFloorRuntime({ ledger, clock: { now: () => now } });
		await runtime.rewrite(
			{ model: "openai/gpt-5.6-sol", messages: [] },
			{ provider: "openrouter", id: "openai/gpt-5.6-sol" },
			"scope",
		);

		let settled = false;
		const flushed = runtime.flush().then(() => {
			settled = true;
		});
		await Promise.resolve();
		assert.equal(settled, false);

		release();
		await flushed;
		assert.equal(settled, true);
	});

	it("handles a rejected detached rewrite append", async () => {
		const { ledger, reject } = deferredLedger();
		const diagnostics: string[] = [];
		let unhandledRejections = 0;
		const onUnhandledRejection = (): void => {
			unhandledRejections += 1;
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			const runtime = createFloorRuntime({
				ledger,
				clock: { now: () => now },
				onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
			});
			await runtime.rewrite(
				{ model: "openai/gpt-5.6-sol", messages: [] },
				{ provider: "openrouter", id: "openai/gpt-5.6-sol" },
				"scope",
			);

			reject(new Error("disk"));
			await runtime.flush();
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.deepEqual(diagnostics, ["ledger append failed: rewrite"]);
			assert.equal(unhandledRejections, 0);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("records rewrites separately from completion outcomes and resolves tiers", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({
			rootDirectory: join(scope, "ledger-root"),
			resolveScope: async () => ({ key: "a".repeat(64), label: "repository" }),
			processId: "p-runtime",
			now: () => now,
		});
		const seenResponseIds: string[] = [];
		const runtime = createFloorRuntime({
			ledger,
			clock: { now: () => now },
			lookup: async (responseId) => {
				seenResponseIds.push(responseId);
				return { kind: "known", tier: "flex" };
			},
		});

		const replacement = await runtime.rewrite(
			{ model: "openai/gpt-5.6-sol", messages: [] },
			{ provider: "openrouter", id: "openai/gpt-5.6-sol" },
			scope,
		);
		assert.equal(replacement?.model, "openai/gpt-5.6-sol:floor");
		await runtime.observeCompletion(
			{ role: "assistant", provider: "openrouter", stopReason: "stop", responseId: "gen-123" },
			async () => undefined,
			scope,
		);
		await runtime.observeCompletion(
			{ role: "assistant", provider: "openrouter", stopReason: "stop" },
			async () => undefined,
			scope,
		);
		await runtime.observeCompletion(
			{ role: "assistant", provider: "openrouter", stopReason: "error", responseId: "gen-error" },
			async () => undefined,
			scope,
		);

		const report = await runtime.report({ range: "process", scope });
		assert.deepEqual(seenResponseIds, ["gen-123"]);
		assert.equal(report.rewrites, 1);
		assert.equal(report.completedGenerations, 2);
		assert.deepEqual(report.tiers, { flex: 1, default: 0, priority: 0, unknown: 1 });
	});

	it("does not delay completion handling while generation metadata propagates", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({
			rootDirectory: join(scope, "ledger-root"),
			resolveScope: async () => ({ key: "a".repeat(64), label: "repository" }),
			processId: "p-runtime-background",
			now: () => now,
		});
		let markLookupStarted: () => void = () => {};
		const lookupStarted = new Promise<void>((resolve) => {
			markLookupStarted = resolve;
		});
		let releaseLookup: () => void = () => {};
		const pendingLookup = new Promise<{ kind: "known"; tier: "flex" }>((resolve) => {
			releaseLookup = () => resolve({ kind: "known", tier: "flex" });
		});
		const runtime = createFloorRuntime({
			ledger,
			clock: { now: () => now },
			lookup: async () => {
				markLookupStarted();
				return pendingLookup;
			},
		});

		let completionSettled = false;
		const completion = runtime
			.observeCompletion(
				{ role: "assistant", provider: "openrouter", stopReason: "stop", responseId: "gen-delayed" },
				async () => undefined,
				scope,
			)
			.then(() => {
				completionSettled = true;
			});
		await lookupStarted;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const settledBeforeLookup = completionSettled;
		releaseLookup();
		await completion;

		assert.equal(settledBeforeLookup, true);
	});

	it("keeps a background lookup alive until shutdown so a turn abort cannot discard it", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({
			rootDirectory: join(scope, "ledger-root"),
			resolveScope: async () => ({ key: "a".repeat(64), label: "repository" }),
			processId: "p-runtime-turn-abort",
			now: () => now,
		});
		let lookupSignal: AbortSignal | undefined;
		let releaseLookup: () => void = () => {};
		const pendingLookup = new Promise<{ kind: "known"; tier: "flex" }>((resolve) => {
			releaseLookup = () => resolve({ kind: "known", tier: "flex" });
		});
		const runtime = createFloorRuntime({
			ledger,
			clock: { now: () => now },
			lookup: async (_responseId, _authResolver, options) => {
				lookupSignal = options.signal;
				return await pendingLookup;
			},
		});

		await runtime.observeCompletion(
			{ role: "assistant", provider: "openrouter", stopReason: "toolUse", responseId: "gen-turn-abort" },
			async () => undefined,
			scope,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		// The runtime owns the only abort source, so an aborted agent turn cannot
		// cancel telemetry that has already been handed to the lookup.
		assert.equal(lookupSignal?.aborted, false);
		releaseLookup();
		await runtime.shutdown();
		const report = await runtime.report({ range: "process", scope });

		assert.equal(lookupSignal?.aborted, true);
		assert.deepEqual(report.tiers, { flex: 1, default: 0, priority: 0, unknown: 0 });
	});

	it("aborts pending metadata work during shutdown without recording a failed resolution", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({
			rootDirectory: join(scope, "ledger-root"),
			resolveScope: async () => ({ key: "a".repeat(64), label: "repository" }),
			processId: "p-runtime-shutdown",
			now: () => now,
		});
		let markLookupStarted: () => void = () => {};
		const lookupStarted = new Promise<void>((resolve) => {
			markLookupStarted = resolve;
		});
		let lookupAborted = false;
		const runtime = createFloorRuntime({
			ledger,
			clock: { now: () => now },
			lookup: async (_responseId, _authResolver, options) => {
				markLookupStarted();
				return await new Promise((resolve) => {
					const finish = (): void => {
						lookupAborted = true;
						resolve({ kind: "unknown", reason: "lookup-failed" });
					};
					if (options.signal.aborted) finish();
					else options.signal.addEventListener("abort", finish, { once: true });
				});
			},
		});

		await runtime.observeCompletion(
			{ role: "assistant", provider: "openrouter", stopReason: "stop", responseId: "gen-shutdown" },
			async () => undefined,
			scope,
		);
		await lookupStarted;
		await runtime.shutdown();
		const report = await runtime.report({ range: "process", scope });

		assert.equal(lookupAborted, true);
		assert.equal(report.unknownReasons.pending, 1);
		assert.equal(report.unknownReasons["lookup-failed"], 0);
	});

	it("keeps an unavailable lookup as visible unknown data", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({
			rootDirectory: join(scope, "ledger-root"),
			resolveScope: async () => ({ key: "a".repeat(64), label: "repository" }),
			processId: "p-runtime-failure",
			now: () => now,
		});
		const runtime = createFloorRuntime({
			ledger,
			clock: { now: () => now },
			lookup: async () => ({ kind: "unknown", reason: "lookup-failed" }),
		});
		await runtime.observeCompletion(
			{ role: "assistant", provider: "openrouter", stopReason: "length", responseId: "gen-failed" },
			async () => undefined,
			scope,
		);
		const report = await runtime.report({ range: "30d", scope });
		assert.equal(report.completedGenerations, 1);
		assert.equal(report.tiers.unknown, 1);
		assert.equal(report.metadataCoverage, 0);
		assert.equal(report.flexAmongKnownTiers, undefined);
	});
});
