import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT, requestPlanImplement } from "./api.ts";
import type { DeliveryMode } from "./types.ts";

function fakeBus(listener?: (data: unknown) => void) {
	return {
		emit(channel: string, data: unknown) {
			assert.equal(channel, PLAN_IMPLEMENT_REQUEST_EVENT);
			listener?.(data);
		},
		on() {
			return () => {};
		},
	};
}

describe("plan-implement in-process API", () => {
	it("claims synchronously and awaits completion", async () => {
		const calls: { task: string; mode: DeliveryMode; ctx: ExtensionCommandContext }[] = [];
		const ctx = {} as ExtensionCommandContext;
		const pi = {
			events: fakeBus((data) => {
				claimPlanImplementRequest(data, async (task, mode, receivedCtx) => {
					assert.equal(receivedCtx, ctx);
					calls.push({ task, mode, ctx });
				});
			}),
		} as unknown as ExtensionAPI;
		const result = await requestPlanImplement(pi, "Add feature X", "single", ctx);
		assert.deepEqual(result, { handled: true });
		assert.deepEqual(calls, [{ task: "Add feature X", mode: "single", ctx }]);
	});

	it("reports unavailable when plan-implement has no listener", async () => {
		const pi = { events: fakeBus() } as unknown as ExtensionAPI;
		const result = await requestPlanImplement(pi, "", "single", {} as ExtensionCommandContext);
		assert.deepEqual(result, { handled: false });
	});

	it("allows only one listener to claim a request", () => {
		const request = {
			schemaVersion: 1 as const,
			task: "test",
			mode: "single" as DeliveryMode,
			ctx: {} as ExtensionCommandContext,
			claimed: false,
		};
		assert.equal(claimPlanImplementRequest(request, async () => {}), true);
		assert.equal(claimPlanImplementRequest(request, async () => {}), false);
	});

	it("refuses claim on malformed request", () => {
		assert.equal(claimPlanImplementRequest(null, async () => {}), false);
		assert.equal(claimPlanImplementRequest({ schemaVersion: 1, task: 42 }, async () => {}), false);
		assert.equal(claimPlanImplementRequest({ schemaVersion: 1, task: "test", mode: "invalid" }, async () => {}), false);
		assert.equal(claimPlanImplementRequest({ schemaVersion: 2, task: "test", mode: "single" }, async () => {}), false);
	});
});