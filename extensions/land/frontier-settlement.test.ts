import assert from "node:assert/strict";
import test from "node:test";
import type { StackLandFrontier, StackLandOutcome } from "../shared/stack/outcome.ts";
import { applyDelegatedFrontierSettlement } from "./frontier-settlement.ts";
import type { LandResult } from "./types.ts";

const LOCAL_SHA = "a".repeat(40);
const PINNED_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);

const frontier: StackLandFrontier = {
	ref: "kstack/one",
	prNumber: 12,
	url: "https://example.test/12",
	expectedHeadSha: LOCAL_SHA,
	method: "squash",
	state: "not-attempted",
};

function progress(overrides: Partial<Extract<StackLandOutcome, { status: "completed" }>> = {}) {
	return {
		frontiers: [],
		remainingRefs: ["kstack/one"],
		completedMutations: [],
		warnings: [],
		recoveryOperationIds: [],
		...overrides,
	};
}

function landResult(overrides: Partial<LandResult> = {}): LandResult {
	return {
		status: "blocked",
		frontiers: [],
		autopilotRan: false,
		remainingRefs: [],
		completedMutations: [],
		blockers: [],
		...overrides,
	};
}

function apply(response: Parameters<typeof applyDelegatedFrontierSettlement>[0]["response"], prior = progress()) {
	return applyDelegatedFrontierSettlement({ response, frontier, progress: prior });
}

function attempted(state: "queued" | "blocked", expectedHeadSha = LOCAL_SHA): StackLandFrontier {
	return { ...frontier, state, expectedHeadSha };
}

test("blocks when Land is unavailable before progress", () => {
	assert.deepEqual(apply({ handled: false }), {
		kind: "halted",
		outcome: {
			status: "blocked",
			blockers: [{ code: "land-unavailable", message: "The land extension is unavailable." }],
		},
	});
});

test("preserves progress when Land becomes unavailable", () => {
	const prior = progress({ completedMutations: ["merged #11"] });
	assert.deepEqual(apply({ handled: false }, prior), {
		kind: "halted",
		outcome: {
			status: "partial",
			error: "The land extension is unavailable.",
			...prior,
			frontiers: [frontier],
		},
	});
});

test("applies a landed frontier's matching pin and mutations", () => {
	const outcome = landResult({
		status: "landed",
		frontiers: [{ ...frontier, expectedHeadSha: PINNED_SHA, state: "landed" }],
		completedMutations: ["merged #12"],
	});
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "landed",
		frontier: { ...frontier, expectedHeadSha: PINNED_SHA, state: "landed" },
		newCompletedMutations: ["merged #12"],
	});
});

test("keeps the local pin when a landed result has no frontier", () => {
	const outcome = landResult({ status: "landed" });
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "landed",
		frontier: { ...frontier, state: "landed" },
		newCompletedMutations: [],
	});
});

test("ignores a pin reported for a different PR", () => {
	const outcome = landResult({
		status: "landed",
		frontiers: [{ ...frontier, prNumber: 99, expectedHeadSha: OTHER_SHA, state: "landed" }],
	});
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "landed",
		frontier: { ...frontier, state: "landed" },
		newCompletedMutations: [],
	});
});

test("keeps a partially landed frontier queued", () => {
	const outcome = landResult({ status: "partially-landed" });
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "halted",
		outcome: {
			status: "partial",
			error: "Land returned partially-landed.",
			...progress(),
			frontiers: [attempted("queued")],
		},
	});
});

test("preserves indeterminacy regardless of mutations", () => {
	const outcome = landResult({ status: "indeterminate", completedMutations: ["submitted merge"] });
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "halted",
		outcome: {
			status: "indeterminate",
			inFlight: "Land returned indeterminate.",
			...progress(),
			frontiers: [attempted("blocked")],
			completedMutations: ["submitted merge"],
		},
	});
});

for (const status of ["aborted", "declined"] as const) {
	test(`maps ${status} without mutations to cancellation`, () => {
		const outcome = landResult({ status });
		assert.deepEqual(apply({ handled: true, outcome }), {
			kind: "halted",
			outcome: { status: "cancelled", ...progress(), frontiers: [attempted("blocked")] },
		});
	});
}

test("maps an abort after an earlier mutation to partial", () => {
	const prior = progress({ completedMutations: ["merged #11"] });
	const outcome = landResult({ status: "aborted" });
	assert.deepEqual(apply({ handled: true, outcome }, prior), {
		kind: "halted",
		outcome: {
			status: "partial",
			error: "Land returned aborted.",
			...prior,
			frontiers: [attempted("blocked")],
		},
	});
});

test("maps a decline with a current mutation to partial", () => {
	const outcome = landResult({ status: "declined", completedMutations: ["marked ready"] });
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "halted",
		outcome: {
			status: "partial",
			error: "Land returned declined.",
			...progress(),
			frontiers: [attempted("blocked")],
			completedMutations: ["marked ready"],
		},
	});
});

test("maps failure without mutations to failed", () => {
	const outcome = landResult({ status: "failed" });
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "halted",
		outcome: {
			status: "failed",
			error: "Land returned failed.",
			...progress(),
			frontiers: [attempted("blocked")],
		},
	});
});

test("maps failure with mutations to partial", () => {
	const outcome = landResult({ status: "failed", completedMutations: ["marked ready"] });
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "halted",
		outcome: {
			status: "partial",
			error: "Land returned failed.",
			...progress(),
			frontiers: [attempted("blocked")],
			completedMutations: ["marked ready"],
		},
	});
});

test("joins blocker messages and applies the matching pin", () => {
	const outcome = landResult({
		status: "blocked",
		frontiers: [{ ...frontier, expectedHeadSha: PINNED_SHA, state: "blocked" }],
		blockers: ["first blocker", "second blocker"],
	});
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "halted",
		outcome: {
			status: "partial",
			error: "first blocker second blocker",
			...progress(),
			frontiers: [attempted("blocked", PINNED_SHA)],
		},
	});
});

test("falls back to the Land status when blockers are empty", () => {
	const outcome = landResult({ status: "blocked" });
	assert.deepEqual(apply({ handled: true, outcome }), {
		kind: "halted",
		outcome: {
			status: "partial",
			error: "Land returned blocked.",
			...progress(),
			frontiers: [attempted("blocked")],
		},
	});
});
