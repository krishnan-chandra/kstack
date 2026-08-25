import assert from "node:assert/strict";
import test from "node:test";
import type { BoundaryValue } from "../shared/validation.ts";
import {
	claimPrAutopilotRequest,
	PRAUTOPILOT_REQUEST_EVENT,
	type PrAutopilotRequest,
	requestPrAutopilot,
} from "./api.ts";
import { issueAutopilotConfirmation } from "./confirmation.ts";
import type { AutopilotResult } from "./types.ts";

const outcome: AutopilotResult = {
	status: "blocked",
	mergeReady: false,
	cyclesCompleted: 0,
	blockedReasons: ["no"],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};

const ctx = { cwd: "/repo" };

function fakeBus() {
	const listeners: Array<(value: BoundaryValue) => void> = [];
	const emitted: BoundaryValue[] = [];
	const pi = {
		events: {
			on: (_name: string, listener: (value: BoundaryValue) => void) => listeners.push(listener),
			emit: (name: string, value: BoundaryValue) => {
				assert.equal(name, PRAUTOPILOT_REQUEST_EVENT);
				emitted.push(value);
				for (const listener of listeners) listener(value);
			},
		},
	};
	return { pi, emitted };
}

test("claimed request with an explicit PR forwards mode, PR, cwd, and context", async () => {
	const { pi } = fakeBus();
	const seen: Array<{ mode: string; prNumber: number | undefined; cwd: string; ctx: BoundaryValue }> = [];
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async (mode, prNumber, requestCtx, cwd) => {
			seen.push({ mode, prNumber, cwd, ctx: requestCtx });
			return outcome;
		}),
	);
	const result = await requestPrAutopilot(
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
		"drive",
		42,
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		"/repo",
	);
	assert.deepEqual(result, { handled: true, outcome });
	assert.deepEqual(seen, [{ mode: "drive", prNumber: 42, cwd: "/repo", ctx }]);
});

test("claimed request with no PR forwards undefined and succeeds", async () => {
	const { pi } = fakeBus();
	const seen: Array<number | undefined> = [];
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async (_mode, prNumber) => {
			seen.push(prNumber);
			return outcome;
		}),
	);
	const result = await requestPrAutopilot(
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
		"check",
		undefined,
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		"/repo",
	);
	assert.deepEqual(result, { handled: true, outcome });
	assert.deepEqual(seen, [undefined]);
});

test("invalid supplied PR is rejected before emission", async () => {
	const { pi, emitted } = fakeBus();
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, () => {
		assert.fail("invalid PR must not emit");
	});
	assert.deepEqual(
		await requestPrAutopilot(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			"check",
			0,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			"/repo",
		),
		{ handled: false },
	);
	assert.deepEqual(
		await requestPrAutopilot(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			"check",
			1.5,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			"/repo",
		),
		{ handled: false },
	);
	assert.equal(emitted.length, 0);
});

test("a minted confirmation passes through the request channel", async () => {
	const { pi } = fakeBus();
	const seen: BoundaryValue[] = [];
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async (_mode, _prNumber, _ctx, _cwd, confirmation) => {
			seen.push(confirmation);
			return outcome;
		}),
	);
	const confirmation = issueAutopilotConfirmation();
	const result = await requestPrAutopilot(
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
		"watch",
		7,
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		"/repo",
		confirmation,
	);
	assert.deepEqual(result, { handled: true, outcome });
	assert.deepEqual(seen, [confirmation]);
});

test("a forged confirmation object is rejected as an invalid payload", async () => {
	const { pi } = fakeBus();
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async () => {
			assert.fail("a forged confirmation must not be claimed");
		}),
	);
	const forged = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		confirmed: true,
	} as never;
	assert.deepEqual(
		await requestPrAutopilot(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			"watch",
			7,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			"/repo",
			forged,
		),
		{
			handled: false,
		},
	);
});

test("unclaimed request reports unavailable", async () => {
	const pi = { events: { emit: () => {} } };
	assert.deepEqual(
		await requestPrAutopilot(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
			"watch",
			7,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			"/repo",
		),
		{ handled: false },
	);
});

test("a second claim attempt does not settle the request twice", async () => {
	let runs = 0;
	const envelope = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		schemaVersion: 1,
		payload: { mode: "threads" as const, prNumber: 9, ctx, cwd: "/repo" },
		claimed: false,
	} as PrAutopilotRequest;
	assert.equal(
		claimPrAutopilotRequest(envelope, async () => {
			runs++;
			return outcome;
		}),
		true,
	);
	assert.equal(
		claimPrAutopilotRequest(envelope, async () => {
			runs++;
			return outcome;
		}),
		false,
	);
	assert.deepEqual(await envelope.completion, outcome);
	assert.equal(runs, 1);
});

test("payload with a valid AbortSignal is accepted", async () => {
	const { pi } = fakeBus();
	const controller = new AbortController();
	const seen: Array<AbortSignal | undefined> = [];
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async (_mode, _prNumber, _ctx, _cwd, _confirmation, signal) => {
			seen.push(signal);
			return outcome;
		}),
	);
	const result = await requestPrAutopilot(
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
		"check",
		3,
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		"/repo",
		undefined,
		controller.signal,
	);
	assert.equal(result.handled, true);
	assert.equal(seen.length, 1);
	assert.strictEqual(seen[0], controller.signal);
});

test("payload with signal set to a non-signal value is rejected", async () => {
	const { pi, emitted } = fakeBus();
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async () => {
			assert.fail("non-signal signal value must not be claimed");
		}),
	);
	const forgedEnvelope: PrAutopilotRequest = {
		schemaVersion: 1,
		payload: {
			mode: "check",
			prNumber: 5,
			ctx: /* SAFETY: This test controls the minimal context fixture. */ ctx as never,
			cwd: "/repo",
			// @ts-expect-error: This test intentionally bypasses type safety to exercise runtime rejection.
			signal: "not-a-signal",
		},
		claimed: false,
	};
	pi.events.emit(PRAUTOPILOT_REQUEST_EVENT, forgedEnvelope);
	// The emission happens but the envelope is not claimed (invalid payload).
	assert.equal(emitted.length, 1);
	assert.equal(forgedEnvelope.claimed, false);
});

test("requestPrAutopilot without signal argument passes undefined", async () => {
	const { pi } = fakeBus();
	const seen: Array<AbortSignal | undefined> = [];
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async (_mode, _prNumber, _ctx, _cwd, _confirmation, signal) => {
			seen.push(signal);
			return outcome;
		}),
	);
	await requestPrAutopilot(
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ pi as never,
		"check",
		2,
		/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		"/repo",
	);
	assert.strictEqual(seen[0], undefined);
});
