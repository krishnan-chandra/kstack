import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT, requestPlanImplement } from "./api.ts";
import type { ChangeKind } from "./change-kind.ts";
import type { DeliveryMode, WorkLocation } from "./types.ts";

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
		const calls: {
			task: string;
			mode: DeliveryMode;
			workLocation: WorkLocation;
			changeKind: ChangeKind;
			ctx: ExtensionCommandContext;
		}[] = [];
		const ctx = {} as ExtensionCommandContext;
		const pi = {
			events: fakeBus((data) => {
				claimPlanImplementRequest(data, async (task, mode, workLocation, changeKind, receivedCtx) => {
					assert.equal(receivedCtx, ctx);
					calls.push({ task, mode, workLocation, changeKind, ctx });
				});
			}),
		} as unknown as ExtensionAPI;
		const result = await requestPlanImplement(pi, "Add feature X", "single", "worktree", "feature", ctx);
		assert.deepEqual(result, { handled: true });
		assert.deepEqual(calls, [
			{ task: "Add feature X", mode: "single", workLocation: "worktree", changeKind: "feature", ctx },
		]);
	});

	it("keeps the legacy caller signature and missing workLocation payload compatible", async () => {
		const ctx = {} as ExtensionCommandContext;
		let received: WorkLocation | undefined;
		const pi = {
			events: fakeBus((data) => {
				const request = data as { workLocation?: WorkLocation };
				delete request.workLocation;
				claimPlanImplementRequest(data, async (_task, _mode, workLocation) => {
					received = workLocation;
				});
			}),
		} as unknown as ExtensionAPI;
		const result = await requestPlanImplement(pi, "Legacy task", "single", "generic", ctx);
		assert.deepEqual(result, { handled: true });
		assert.equal(received, "current");
	});

	it("reports unavailable when plan-implement has no listener", async () => {
		const pi = { events: fakeBus() } as unknown as ExtensionAPI;
		const result = await requestPlanImplement(pi, "", "single", "current", "generic", {} as ExtensionCommandContext);
		assert.deepEqual(result, { handled: false });
	});

	it("allows only one listener to claim a request", () => {
		const request = {
			schemaVersion: 1 as const,
			task: "test",
			mode: "single" as DeliveryMode,
			workLocation: "current" as WorkLocation,
			changeKind: "generic" as ChangeKind,
			ctx: {} as ExtensionCommandContext,
			claimed: false,
		};
		assert.equal(
			claimPlanImplementRequest(request, async () => {}),
			true,
		);
		assert.equal(
			claimPlanImplementRequest(request, async () => {}),
			false,
		);
	});

	it("refuses claim on malformed request", () => {
		assert.equal(
			claimPlanImplementRequest(null, async () => {}),
			false,
		);
		assert.equal(
			claimPlanImplementRequest({ schemaVersion: 1, task: 42 }, async () => {}),
			false,
		);
		assert.equal(
			claimPlanImplementRequest({ schemaVersion: 1, task: "test", mode: "invalid" }, async () => {}),
			false,
		);
		assert.equal(
			claimPlanImplementRequest(
				{ schemaVersion: 1, task: "test", mode: "stack", workLocation: "worktree", changeKind: "generic", ctx: {} },
				async () => {},
			),
			false,
		);
		assert.equal(
			claimPlanImplementRequest({ schemaVersion: 2, task: "test", mode: "single" }, async () => {}),
			false,
		);
	});
});
