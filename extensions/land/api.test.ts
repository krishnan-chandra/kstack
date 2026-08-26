import assert from "node:assert/strict";
import test from "node:test";
import type { BoundaryValue } from "../shared/validation.ts";
import { claimLandRequest, isLandRequest, LAND_REQUEST_EVENT, requestLand, requestStackFrontierLand } from "./api.ts";
import type { LandResult } from "./types.ts";

const SHA = "a".repeat(40);
const outcome: LandResult = {
	status: "declined",
	frontiers: [],
	autopilotRan: false,
	remainingRefs: [],
	completedMutations: [],
	blockers: ["no"],
};

function fixture() {
	const listeners: Array<(value: BoundaryValue) => void> = [];
	const pi = {
		events: {
			on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
			emit: (name: string, value: BoundaryValue) => {
				assert.equal(name, LAND_REQUEST_EVENT);
				for (const listener of listeners) listener(value);
			},
		},
	};
	return { pi, listeners };
}

test("dispatches interactive and delegated frontier requests", async () => {
	const { pi } = fixture();
	const kinds: string[] = [];
	pi.events.on(LAND_REQUEST_EVENT, (value) =>
		claimLandRequest(value, async (request) => {
			kinds.push(request.kind);
			return outcome;
		}),
	);
	const ctx = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as never;
	assert.deepEqual(
		await requestLand(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			{ target: { kind: "single", prNumber: 3 }, readiness: "check" },
			ctx,
		),
		{ handled: true, outcome },
	);
	assert.deepEqual(
		await requestStackFrontierLand(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			{
				options: { target: { kind: "single", prNumber: 4 }, readiness: "watch", method: "squash" },
				expectedHeadSha: SHA,
				ctx,
			},
		),
		{ handled: true, outcome },
	);
	assert.deepEqual(kinds, ["interactive", "stack-frontier"]);
});

function envelope(payload: BoundaryValue): BoundaryValue {
	return { schemaVersion: 1, payload, claimed: false };
}

test("validates request variants and exact delegated heads", () => {
	const options = { target: { kind: "single", prNumber: 3 }, readiness: "check", method: "squash" };
	assert.equal(isLandRequest(envelope({ kind: "interactive", options, ctx: {} })), true);
	assert.equal(
		isLandRequest(
			envelope({
				kind: "stack-frontier",
				options,
				expectedHeadSha: SHA,
				signal: new AbortController().signal,
				ctx: {},
			}),
		),
		true,
	);
	for (const expectedHeadSha of ["a".repeat(39), "A".repeat(40), "z".repeat(40)]) {
		assert.equal(isLandRequest(envelope({ kind: "stack-frontier", options, expectedHeadSha, ctx: {} })), false);
	}
	assert.equal(isLandRequest(envelope({ kind: "stack-frontier", options, ctx: {} })), false);
	assert.equal(
		isLandRequest(
			envelope({
				kind: "stack-frontier",
				options: { target: { kind: "single", prNumber: 3 }, readiness: "check" },
				expectedHeadSha: SHA,
				ctx: {},
			}),
		),
		false,
	);
	assert.equal(isLandRequest(envelope({ kind: "interactive", options, expectedHeadSha: SHA, ctx: {} })), false);
	assert.equal(
		isLandRequest(envelope({ kind: "interactive", options, signal: new AbortController().signal, ctx: {} })),
		false,
	);
});

test("rejects malformed options and contexts", () => {
	for (const payload of [
		{ kind: "interactive", options: { target: { kind: "stack", prNumber: 3 }, readiness: "check" }, ctx: {} },
		{ kind: "interactive", options: { target: { kind: "single", prNumber: 0 }, readiness: "check" }, ctx: {} },
		{ kind: "interactive", options: { target: { kind: "single", prNumber: 3 }, readiness: "later" }, ctx: {} },
		{
			kind: "interactive",
			options: { target: { kind: "single", prNumber: 3 }, readiness: "check", method: "merge" },
			ctx: {},
		},
		{ kind: "interactive", options: { target: { kind: "single", prNumber: 3 }, readiness: "check", cwd: "" }, ctx: {} },
		{ kind: "interactive", options: { target: { kind: "single", prNumber: 3 }, readiness: "check" }, ctx: null },
	]) {
		assert.equal(isLandRequest(envelope(payload)), false);
	}
});

test("claims once and reports an unavailable listener", async () => {
	const { pi } = fixture();
	let claims = 0;
	const claim = async () => {
		claims++;
		return outcome;
	};
	pi.events.on(LAND_REQUEST_EVENT, (value) => claimLandRequest(value, claim));
	pi.events.on(LAND_REQUEST_EVENT, (value) => claimLandRequest(value, claim));
	await requestLand(
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
		{ target: { kind: "single", prNumber: 3 }, readiness: "check" },
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as never,
	);
	assert.equal(claims, 1);

	const unavailable = { events: { emit: () => {} } };
	assert.deepEqual(
		await requestLand(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ unavailable as never,
			{ target: { kind: "single", prNumber: 3 }, readiness: "check" },
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as never,
		),
		{ handled: false },
	);
});
