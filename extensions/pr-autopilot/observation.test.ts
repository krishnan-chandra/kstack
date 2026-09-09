import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkObservation, createPrObservation, refreshObservation, settleObservation } from "./observation.ts";
import type { AutopilotPersistedState, PRState, ReviewThread } from "./types.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SETTLE_POLL_LIMIT = 5;

function persistedState(overrides: Partial<AutopilotPersistedState> = {}): AutopilotPersistedState {
	return {
		schemaVersion: 3,
		repoKey: "repo",
		prNumber: 42,
		headSha: HEAD,
		handled: [],
		pendingReviewReplies: [],
		legacyPendingReplyIds: [],
		flakeRetried: [],
		flakeRunRetries: [],
		...overrides,
	};
}

function snapshot(overrides: Partial<PRState> = {}): PRState {
	return {
		number: 42,
		title: "Fix the thing",
		state: "open",
		isDraft: false,
		headSha: HEAD,
		verifiedHeadSha: overrides.verifiedHeadSha === undefined ? null : overrides.verifiedHeadSha,
		baseRef: "main",
		headRef: "kstack/fix-thing",
		mergeable: "mergeable",
		mergeStateStatus: "CLEAN",
		checks: [],
		threads: [],
		hasUnresolvedThreads: false,
		...overrides,
	};
}

function reviewThread(id: string): ReviewThread {
	return {
		id,
		commenter: "reviewer",
		body: "Please look",
		source: "review-thread",
		version: "a".repeat(64),
	};
}

function failingCheck(runId: string) {
	return {
		name: "build",
		status: "failure" as const,
		conclusion: "failure" as const,
		runId,
	};
}

function pendingSnapshot(overrides: Partial<PRState> = {}): PRState {
	return snapshot({
		mergeable: "unknown",
		mergeStateStatus: "UNKNOWN",
		checks: [{ name: "test", status: "success", conclusion: "success" }],
		verifiedHeadSha: overrides.headSha ?? HEAD,
		...overrides,
	});
}

function readySnapshot(headSha: string): PRState {
	return snapshot({
		headSha,
		verifiedHeadSha: headSha,
		mergeable: "mergeable",
		mergeStateStatus: "CLEAN",
	});
}

function createHarness(options: {
	queue: Array<PRState | string>;
	persistWritesBlocked?: boolean;
	sleepError?: Error;
}) {
	const reads: Array<{ verifiedHeadSha: string | null; persisted: AutopilotPersistedState }> = [];
	const saves: AutopilotPersistedState[] = [];
	const waits: number[] = [];
	const controller = new AbortController();
	const queue = [...options.queue];
	const observation = createPrObservation({
		read: async (verifiedHeadSha, persisted) => {
			reads.push({ verifiedHeadSha, persisted: structuredClone(persisted) });
			if (queue.length === 0) throw new Error("unexpected PR read");
			const next = queue.shift();
			if (next === undefined) throw new Error("unexpected PR read");
			return next;
		},
		sleep: async (delayMs, signal) => {
			waits.push(delayMs);
			if (options.sleepError) throw options.sleepError;
			signal.throwIfAborted();
		},
		save: async (state) => {
			saves.push(structuredClone(state));
		},
		notify: () => {},
		signal: controller.signal,
		persistWritesBlocked: options.persistWritesBlocked === true,
		prNumber: 42,
	});
	return { reads, saves, waits, observation, controller };
}

describe("PR observation protocol", () => {
	it("reconciles legacy CI retries after every successful observation", async () => {
		const legacy = persistedState({ flakeRetried: [`build@${HEAD}`] });
		const withFailure = snapshot({ checks: [failingCheck("123")] });
		const harness = createHarness({
			queue: [
				{ ...withFailure, verifiedHeadSha: null },
				{ ...withFailure, verifiedHeadSha: HEAD },
				{ ...withFailure, verifiedHeadSha: HEAD },
			],
		});

		const checked = await checkObservation(harness.observation, legacy);
		assert.equal(checked.kind, "incomplete");
		assert.deepEqual(harness.saves[0]?.flakeRunRetries, [{ runId: "123", headSha: HEAD }]);

		const refresh = await refreshObservation(harness.observation, checked.persisted);
		assert.equal(refresh.kind, "ok");
		assert.equal(harness.saves.length, 1, "already-converted retries do not save again");

		const settleHarness = createHarness({
			queue: [{ ...withFailure, verifiedHeadSha: HEAD }],
		});
		const settled = await settleObservation(settleHarness.observation, snapshot(), legacy, { poll: false });
		assert.ok(settled.kind === "continue" || settled.kind === "incomplete");
		assert.deepEqual(settleHarness.saves[0]?.flakeRunRetries, [{ runId: "123", headSha: HEAD }]);
	});

	it("reconciles absent legacy pending replies on the first check read and on refresh only", async () => {
		const live = reviewThread("thread-live");
		const starting = persistedState({ legacyPendingReplyIds: ["thread-live", "thread-gone"] });
		const first = snapshot({
			threads: [live],
			hasUnresolvedThreads: true,
			verifiedHeadSha: null,
		});
		const second = snapshot({
			threads: [live],
			hasUnresolvedThreads: true,
			verifiedHeadSha: HEAD,
		});
		const harness = createHarness({ queue: [first, second, second] });

		const checked = await checkObservation(harness.observation, starting);
		assert.equal(checked.kind, "incomplete");
		assert.deepEqual(checked.persisted.legacyPendingReplyIds, ["thread-live"]);
		assert.equal(harness.saves.length, 1);

		const refresh = await refreshObservation(
			harness.observation,
			persistedState({ legacyPendingReplyIds: ["thread-live", "thread-gone"] }),
		);
		assert.equal(refresh.kind, "ok");
		assert.deepEqual(refresh.persisted.legacyPendingReplyIds, ["thread-live"]);

		const settleHarness = createHarness({
			queue: [pendingSnapshot({ verifiedHeadSha: HEAD })],
		});
		const settled = await settleObservation(
			settleHarness.observation,
			pendingSnapshot({ verifiedHeadSha: null }),
			starting,
			{
				poll: false,
			},
		);
		assert.equal(settled.kind, "incomplete");
		assert.deepEqual(settled.persisted.legacyPendingReplyIds, ["thread-live", "thread-gone"]);
		assert.deepEqual(settleHarness.saves, []);
	});

	it("keeps CI reconciliation in memory when persistence is blocked and skips pending-reply reconciliation", async () => {
		const starting = persistedState({
			flakeRetried: [`build@${HEAD}`],
			legacyPendingReplyIds: ["thread-gone"],
		});
		const observed = snapshot({
			checks: [failingCheck("99")],
			verifiedHeadSha: null,
		});
		const harness = createHarness({
			queue: [observed, { ...observed, verifiedHeadSha: HEAD }],
			persistWritesBlocked: true,
		});

		const checked = await checkObservation(harness.observation, starting);
		assert.equal(checked.kind, "incomplete");
		assert.deepEqual(checked.persisted.flakeRunRetries, [{ runId: "99", headSha: HEAD }]);
		assert.deepEqual(checked.persisted.legacyPendingReplyIds, ["thread-gone"]);
		assert.deepEqual(harness.saves, []);
	});

	it("keeps a terminal first check observation decisive when the second read is open", async () => {
		const harness = createHarness({
			queue: [snapshot({ state: "closed", verifiedHeadSha: HEAD }), readySnapshot(HEAD)],
		});
		const checked = await checkObservation(harness.observation, persistedState());
		assert.equal(checked.kind, "incomplete");
		if (checked.kind !== "incomplete") return;
		assert.equal(checked.reason, "PR is closed");
		assert.equal(checked.snapshot.state, "open");
		assert.deepEqual(
			harness.reads.map((read) => read.verifiedHeadSha),
			[null, HEAD],
		);
	});

	it("does not reset the settling budget when the head keeps moving", async () => {
		const pending = (headSha: string) => pendingSnapshot({ headSha, verifiedHeadSha: null });
		const queue = [
			pending(HEAD),
			...Array.from({ length: SETTLE_POLL_LIMIT }, (_, index) => pending(`${index + 1}`.repeat(40))),
		];
		const harness = createHarness({ queue });
		const settled = await settleObservation(
			harness.observation,
			pendingSnapshot({ verifiedHeadSha: null }),
			persistedState(),
			{
				poll: true,
			},
		);
		assert.equal(settled.kind, "incomplete");
		if (settled.kind !== "incomplete") return;
		assert.equal(settled.reason, `mergeability pending after ${SETTLE_POLL_LIMIT} additional observations`);
		assert.equal(harness.reads.length, 1 + SETTLE_POLL_LIMIT);
		assert.equal(harness.waits.length, SETTLE_POLL_LIMIT);
	});

	it("does not poll when settle is asked not to", async () => {
		const harness = createHarness({
			queue: [pendingSnapshot({ verifiedHeadSha: HEAD })],
		});
		const settled = await settleObservation(
			harness.observation,
			pendingSnapshot({ verifiedHeadSha: null }),
			persistedState(),
			{
				poll: false,
			},
		);
		assert.equal(settled.kind, "incomplete");
		assert.deepEqual(harness.waits, []);
		assert.equal(harness.reads.length, 1);
	});

	it("announces a failed first check read and stays silent on a failed second read", async () => {
		const first = createHarness({ queue: ["mergeability read failed"] });
		const firstResult = await checkObservation(first.observation, persistedState());
		assert.equal(firstResult.kind, "failed");
		if (firstResult.kind !== "failed") return;
		assert.equal(firstResult.announce, true);

		const second = createHarness({
			queue: [snapshot({ verifiedHeadSha: null }), "mergeability read failed"],
		});
		const secondResult = await checkObservation(second.observation, persistedState());
		assert.equal(secondResult.kind, "failed");
		if (secondResult.kind !== "failed") return;
		assert.equal(secondResult.announce, false);
		assert.equal(secondResult.snapshot?.headSha, HEAD);
	});
});
