import assert from "node:assert/strict";
import test from "node:test";
import {
	claimPrAutopilotRequest,
	PRAUTOPILOT_REQUEST_EVENT,
	type PrAutopilotRequest,
	requestPrAutopilot,
} from "./api.ts";
import { issueAutopilotConfirmation } from "./confirmation.ts";
import type { AutopilotResult } from "./driver.ts";

const outcome: AutopilotResult = {
	status: "blocked",
	mergeReady: false,
	cyclesCompleted: 0,
	blockedReasons: ["no"],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};

const ctx = { cwd: "/repo" };

function fakeBus() {
	const listeners: Array<(value: unknown) => void> = [];
	const emitted: unknown[] = [];
	const pi = {
		events: {
			on: (_name: string, listener: (value: unknown) => void) => listeners.push(listener),
			emit: (name: string, value: unknown) => {
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
	const seen: Array<{ mode: string; prNumber: number | undefined; cwd: string; ctx: unknown }> = [];
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async (mode, prNumber, requestCtx, cwd) => {
			seen.push({ mode, prNumber, cwd, ctx: requestCtx });
			return outcome;
		}),
	);
	const result = await requestPrAutopilot(pi as never, "drive", 42, ctx as never, "/repo");
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
	const result = await requestPrAutopilot(pi as never, "check", undefined, ctx as never, "/repo");
	assert.deepEqual(result, { handled: true, outcome });
	assert.deepEqual(seen, [undefined]);
});

test("invalid supplied PR is rejected before emission", async () => {
	const { pi, emitted } = fakeBus();
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, () => {
		assert.fail("invalid PR must not emit");
	});
	assert.deepEqual(await requestPrAutopilot(pi as never, "check", 0, ctx as never, "/repo"), { handled: false });
	assert.deepEqual(await requestPrAutopilot(pi as never, "check", 1.5, ctx as never, "/repo"), { handled: false });
	assert.equal(emitted.length, 0);
});

test("a minted confirmation passes through the request channel", async () => {
	const { pi } = fakeBus();
	const seen: unknown[] = [];
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (value) =>
		claimPrAutopilotRequest(value, async (_mode, _prNumber, _ctx, _cwd, confirmation) => {
			seen.push(confirmation);
			return outcome;
		}),
	);
	const confirmation = issueAutopilotConfirmation();
	const result = await requestPrAutopilot(pi as never, "watch", 7, ctx as never, "/repo", confirmation);
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
	const forged = { confirmed: true } as never;
	assert.deepEqual(await requestPrAutopilot(pi as never, "watch", 7, ctx as never, "/repo", forged), {
		handled: false,
	});
});

test("unclaimed request reports unavailable", async () => {
	const pi = { events: { emit: () => {} } };
	assert.deepEqual(await requestPrAutopilot(pi as never, "watch", 7, ctx as never, "/repo"), { handled: false });
});

test("a second claim attempt does not settle the request twice", async () => {
	let runs = 0;
	const envelope = {
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
