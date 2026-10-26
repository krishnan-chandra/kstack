import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import type { AgentHost, openPaneHost } from "./agent-host.ts";
import { createPaneAcquisitionOwner } from "./pane-acquisition.ts";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const options = { owner: "test", label: "test", cwd: "/repo", maxAgents: 1 };
function fixture() {
	const calls: Array<Parameters<AgentHost["dispose"]>[0]> = [];
	const host: AgentHost = {
		tabId: "w1:t1",
		exchangeDir: "/injected",
		async start() {
			throw new Error("not expected");
		},
		async dispose(options) {
			calls.push(options);
		},
	};
	return { host, calls };
}
function owner(openPane: typeof openPaneHost) {
	return createPaneAcquisitionOwner({
		openPane,
		hostDeps: () => ({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) }),
	});
}

describe("pane acquisition ownership", () => {
	it("does not open aborted or disposed requests", async () => {
		let opens = 0;
		const acquisition = owner(async () => {
			opens++;
			return { ok: true, host: fixture().host };
		});
		const abort = new AbortController();
		abort.abort();
		assert.equal((await acquisition.acquire(options, abort.signal)).ok, false);
		await acquisition.dispose();
		assert.equal((await acquisition.acquire(options, new AbortController().signal)).ok, false);
		assert.equal(opens, 0);
	});

	it("settles cancellation before opening and joins late teardown after disposal", async () => {
		const opening = deferred<Awaited<ReturnType<typeof openPaneHost>>>();
		const entered = deferred();
		const closing = deferred();
		const closeEntered = deferred();
		const { host, calls } = fixture();
		host.dispose = async (options) => {
			calls.push(options);
			closeEntered.resolve();
			await closing.promise;
		};
		const acquisition = owner(async () => {
			entered.resolve();
			return opening.promise;
		});
		const abort = new AbortController();
		const result = acquisition.acquire(options, abort.signal);
		await entered.promise;
		assert.equal(getEventListeners(abort.signal, "abort").length, 1);
		abort.abort();
		assert.equal((await result).ok, false);
		assert.equal(getEventListeners(abort.signal, "abort").length, 0);
		const disposing = acquisition.dispose();
		assert.equal(acquisition.dispose(), disposing);
		let done = false;
		void disposing.then(() => {
			done = true;
		});
		await Promise.resolve();
		assert.equal(done, false);
		opening.resolve({ ok: true, host });
		await closeEntered.promise;
		assert.equal(done, false);
		closing.resolve();
		await disposing;
		assert.deepEqual(calls, [{ closeTab: true }]);
	});

	it("disposal cancels pending acquisition even without a round abort", async () => {
		const opening = deferred<Awaited<ReturnType<typeof openPaneHost>>>();
		const { host, calls } = fixture();
		const acquisition = owner(async () => opening.promise);
		const result = acquisition.acquire(options, new AbortController().signal);
		const disposing = acquisition.dispose();
		assert.equal((await result).ok, false);
		opening.resolve({ ok: true, host });
		await disposing;
		assert.deepEqual(calls, [{ closeTab: true }]);
	});

	it("keeps concurrent attempts independent and handles rejection after cancellation", async () => {
		const rejecting = deferred<void>();
		const first = fixture();
		let opens = 0;
		const acquisition = owner(async () => {
			if (opens++ === 0) return { ok: true, host: first.host };
			await rejecting.promise;
			throw new Error("late opener failure");
		});
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();
		const firstResult = acquisition.acquire(options, firstAbort.signal);
		const secondResult = acquisition.acquire(options, secondAbort.signal);
		secondAbort.abort();
		assert.equal((await secondResult).ok, false);
		assert.equal((await firstResult).ok, true);
		// A later abort of an already-delivered host does not transfer it to discard.
		firstAbort.abort();
		const disposing = acquisition.dispose();
		rejecting.resolve();
		await assert.rejects(disposing, /late opener failure/);
		assert.deepEqual(first.calls, [undefined]);
	});

	it("catches opener rejection and removes listeners on success or failure", async () => {
		for (const rejects of [false, true]) {
			const abort = new AbortController();
			const acquisition = owner(async () => {
				if (rejects) throw new Error("opening failed");
				return { ok: true, host: fixture().host };
			});
			const result = await acquisition.acquire(options, abort.signal);
			assert.equal(result.ok, !rejects);
			if (!result.ok) assert.match(result.error, /opening failed/);
			assert.equal(getEventListeners(abort.signal, "abort").length, 0);
			await acquisition.dispose();
		}
	});

	it("owns a success racing abort and discards it only once", async () => {
		const { host, calls } = fixture();
		const abort = new AbortController();
		const acquisition = owner(async () => {
			abort.abort();
			return { ok: true, host };
		});
		assert.equal((await acquisition.acquire(options, abort.signal)).ok, false);
		await acquisition.dispose();
		acquisition.discard(host);
		assert.deepEqual(calls, [{ closeTab: true }]);
	});

	it("rejects unknown discard, makes double discard idempotent, and retains successes", async () => {
		const first = fixture();
		const second = fixture();
		const unknown = fixture();
		let opens = 0;
		const acquisition = owner(async () => ({ ok: true, host: opens++ === 0 ? first.host : second.host }));
		await acquisition.acquire(options, new AbortController().signal);
		assert.throws(() => acquisition.discard(unknown.host), /not acquired/);
		acquisition.discard(first.host);
		acquisition.discard(first.host);
		await acquisition.acquire(options, new AbortController().signal);
		await acquisition.dispose();
		assert.deepEqual(first.calls, [{ closeTab: true }]);
		assert.deepEqual(second.calls, [undefined]);
		assert.deepEqual(unknown.calls, []);
	});

	it("handles cleanup rejection immediately but rejects disposal only after all cleanup settles", async () => {
		const unhandled: unknown[] = [];
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node can emit any thrown value at this rejection boundary.
		const onUnhandled = (error: unknown) => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const first = fixture();
			const second = fixture();
			const closing = deferred();
			const entered = deferred();
			first.host.dispose = async () => {
				throw new Error("close failed");
			};
			second.host.dispose = async () => {
				entered.resolve();
				await closing.promise;
			};
			let opens = 0;
			const acquisition = owner(async () => ({ ok: true, host: opens++ === 0 ? first.host : second.host }));
			await acquisition.acquire(options, new AbortController().signal);
			await acquisition.acquire(options, new AbortController().signal);
			acquisition.discard(first.host);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const disposing = acquisition.dispose();
			const rejection = assert.rejects(
				disposing,
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Assertion callback validates an arbitrary rejected value.
				(error: unknown) => error instanceof AggregateError && error.errors[0].message === "close failed",
			);
			let done = false;
			void rejection.then(() => {
				done = true;
			});
			await entered.promise;
			assert.equal(done, false);
			closing.resolve();
			await rejection;
			assert.equal(acquisition.dispose(), disposing);
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
