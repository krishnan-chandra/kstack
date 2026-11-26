import assert from "node:assert/strict";
import test from "node:test";
import type { BoundaryValue } from "../shared/validation.ts";
import { claimLandRequest, LAND_REQUEST_EVENT, requestStackFrontierLand } from "./api.ts";
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

function envelope(payload: BoundaryValue): BoundaryValue {
	return { schemaVersion: 2, payload, claimed: false };
}

const noop = async () => outcome;

test("dispatches delegated stack-frontier requests", async () => {
	const { pi } = fixture();
	const seen: Array<{ kind: string; repository?: string }> = [];
	pi.events.on(LAND_REQUEST_EVENT, (value) =>
		claimLandRequest(value, async (request) => {
			seen.push({ kind: request.kind, repository: request.repository });
			return outcome;
		}),
	);
	const ctx = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as never;
	assert.deepEqual(
		await requestStackFrontierLand(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			{
				options: { target: { kind: "single", prNumber: 4 }, readiness: "watch", method: "squash" },
				expectedHeadSha: SHA,
				expectedBaseRef: "main",
				repository: "acme/widgets",
				ctx,
			},
		),
		{ handled: true, outcome },
	);
	assert.deepEqual(seen, [{ kind: "stack-frontier", repository: "acme/widgets" }]);
});

test("validates delegated frontier heads, base refs, methods, and signals", () => {
	const options = { target: { kind: "single", prNumber: 3 }, readiness: "check", method: "squash" };
	assert.equal(
		claimLandRequest(
			envelope({
				kind: "stack-frontier",
				options,
				expectedHeadSha: SHA,
				expectedBaseRef: "main",
				signal: new AbortController().signal,
				ctx: {},
			}),
			noop,
		),
		true,
	);
	for (const expectedHeadSha of ["a".repeat(39), "A".repeat(40), "z".repeat(40)]) {
		assert.equal(
			claimLandRequest(
				envelope({ kind: "stack-frontier", options, expectedHeadSha, expectedBaseRef: "main", ctx: {} }),
				noop,
			),
			false,
		);
	}
	assert.equal(
		claimLandRequest(envelope({ kind: "stack-frontier", options, expectedBaseRef: "main", ctx: {} }), noop),
		false,
	);
	assert.equal(
		claimLandRequest(envelope({ kind: "stack-frontier", options, expectedHeadSha: SHA, ctx: {} }), noop),
		false,
	);
	for (const expectedBaseRef of ["", "main\n", "main\0", "a".repeat(257)]) {
		assert.equal(
			claimLandRequest(
				envelope({ kind: "stack-frontier", options, expectedHeadSha: SHA, expectedBaseRef, ctx: {} }),
				noop,
			),
			false,
		);
	}
	assert.equal(
		claimLandRequest(
			envelope({
				kind: "stack-frontier",
				options: { target: { kind: "single", prNumber: 3 }, readiness: "check" },
				expectedHeadSha: SHA,
				expectedBaseRef: "main",
				ctx: {},
			}),
			noop,
		),
		false,
	);
});

test("rejects old-schema, malformed repository, and malformed option envelopes", () => {
	const options = { target: { kind: "single", prNumber: 3 }, readiness: "check", method: "squash" };
	assert.equal(
		claimLandRequest(
			{
				schemaVersion: 1,
				payload: { kind: "stack-frontier", options, expectedHeadSha: SHA, expectedBaseRef: "main", ctx: {} },
				claimed: false,
			},
			noop,
		),
		false,
	);
	for (const repository of ["a/b/c", "--repo", null]) {
		assert.equal(
			claimLandRequest(
				envelope({
					kind: "stack-frontier",
					expectedHeadSha: SHA,
					expectedBaseRef: "main",
					repository,
					ctx: {},
					options,
				}),
				noop,
			),
			false,
		);
	}
	for (const bad of [
		{ kind: "interactive", options, ctx: {} },
		{
			kind: "stack-frontier",
			expectedHeadSha: SHA,
			expectedBaseRef: "main",
			options: { target: { kind: "stack", prNumber: 3 }, readiness: "check", method: "squash" },
			ctx: {},
		},
		{
			kind: "stack-frontier",
			expectedHeadSha: SHA,
			expectedBaseRef: "main",
			options: { target: { kind: "single", prNumber: 0 }, readiness: "check", method: "squash" },
			ctx: {},
		},
		{
			kind: "stack-frontier",
			expectedHeadSha: SHA,
			expectedBaseRef: "main",
			options: { target: { kind: "single", prNumber: 3 }, readiness: "later", method: "squash" },
			ctx: {},
		},
		{
			kind: "stack-frontier",
			expectedHeadSha: SHA,
			expectedBaseRef: "main",
			options: { target: { kind: "single", prNumber: 3 }, readiness: "check", method: "merge" },
			ctx: {},
		},
		{
			kind: "stack-frontier",
			expectedHeadSha: SHA,
			expectedBaseRef: "main",
			options: { target: { kind: "single", prNumber: 3 }, readiness: "check", method: "squash", cwd: "" },
			ctx: {},
		},
		{ kind: "stack-frontier", expectedHeadSha: SHA, expectedBaseRef: "main", options, ctx: null },
	]) {
		assert.equal(claimLandRequest(envelope(bad), noop), false);
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
	const request = {
		options: {
			target: { kind: "single" as const, prNumber: 3 },
			readiness: "check" as const,
			method: "squash" as const,
		},
		expectedHeadSha: SHA,
		expectedBaseRef: "main",
		ctx: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as never,
	};
	await requestStackFrontierLand(
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
		request,
	);
	assert.equal(claims, 1);

	const unavailable = { events: { emit: () => {} } };
	assert.deepEqual(
		await requestStackFrontierLand(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ unavailable as never,
			request,
		),
		{ handled: false },
	);
});
