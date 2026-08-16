import assert from "node:assert/strict";
import test from "node:test";
import { issueAutopilotConfirmation } from "../pr-autopilot/confirmation.ts";
import { claimLandRequest, isLandRequest, LAND_REQUEST_EVENT, requestLand } from "./api.ts";
import { issueLandConfirmation } from "./confirmation.ts";
import type { LandResult } from "./types.ts";

const outcome: LandResult = {
	status: "declined",
	frontiers: [],
	autopilotRan: false,
	remainingBookmarks: [],
	completedMutations: [],
	blockers: ["no"],
};

test("claims synchronously and awaits a structured outcome", async () => {
	const listeners: Array<(value: unknown) => void> = [];
	const pi = {
		events: {
			on: (_name: string, listener: (value: unknown) => void) => listeners.push(listener),
			emit: (name: string, value: unknown) => {
				assert.equal(name, LAND_REQUEST_EVENT);
				for (const listener of listeners) listener(value);
			},
		},
	};
	pi.events.on(LAND_REQUEST_EVENT, (value) => claimLandRequest(value, async () => outcome));
	const result = await requestLand(
		pi as never,
		{ target: { kind: "single", prNumber: 3 }, readiness: "check" },
		{} as never,
	);
	assert.deepEqual(result, { handled: true, outcome });
});

test("rejects malformed and removed stack requests", () => {
	assert.equal(
		isLandRequest({
			schemaVersion: 1,
			payload: {
				options: { target: { kind: "stack", topBookmark: "x" }, readiness: "check" },
				ctx: {},
			},
			claimed: false,
		}),
		false,
	);
	assert.equal(
		isLandRequest({
			schemaVersion: 1,
			payload: {
				options: { target: { kind: "single", prNumber: 3 }, readiness: "check", confirmation: true },
				ctx: {},
			},
			claimed: false,
		}),
		false,
	);
	assert.equal(
		isLandRequest({
			schemaVersion: 1,
			payload: {
				options: {
					target: { kind: "single", prNumber: 3 },
					readiness: "check",
					confirmation: issueLandConfirmation(),
					autopilotConfirmation: issueAutopilotConfirmation(),
				},
				ctx: {},
			},
			claimed: false,
		}),
		true,
	);
	assert.equal(
		isLandRequest({
			schemaVersion: 1,
			payload: {
				options: { target: { kind: "single", prNumber: 3 }, readiness: "check", autopilotConfirmation: true },
				ctx: {},
			},
			claimed: false,
		}),
		false,
	);
	assert.equal(
		isLandRequest({
			schemaVersion: 1,
			payload: {
				options: { target: { kind: "single", prNumber: 0 }, readiness: "check" },
				ctx: {},
			},
			claimed: false,
		}),
		false,
	);
});

test("reports an unavailable listener", async () => {
	const pi = { events: { emit: () => {} } };
	assert.deepEqual(
		await requestLand(pi as never, { target: { kind: "single", prNumber: 3 }, readiness: "check" }, {} as never),
		{ handled: false },
	);
});
