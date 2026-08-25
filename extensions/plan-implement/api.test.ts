import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChangeKind } from "../shared/change-kind.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT, requestPlanImplement } from "./api.ts";
import type { DeliveryMode, WorkLocation } from "./types.ts";

function fakeBus(listener?: (data: BoundaryValue) => void) {
	return {
		emit(channel: string, data: BoundaryValue) {
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
			fast: boolean;
			ctx: ExtensionCommandContext;
		}[] = [];
		const ctx =
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as ExtensionCommandContext;
		const pi = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
			events: fakeBus((data) => {
				claimPlanImplementRequest(data, async (task, mode, workLocation, changeKind, fast, receivedCtx) => {
					assert.equal(receivedCtx, ctx);
					calls.push({ task, mode, workLocation, changeKind, fast, ctx });
				});
			}),
		} as never;
		const result = await requestPlanImplement(pi, "Add feature X", "single", "worktree", "feature", false, ctx);
		assert.deepEqual(result, { handled: true });
		assert.deepEqual(calls, [
			{ task: "Add feature X", mode: "single", workLocation: "worktree", changeKind: "feature", fast: false, ctx },
		]);
	});

	it("reports unavailable when plan-implement has no listener", async () => {
		const pi = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
			events: fakeBus(),
		} as never;
		const result = await requestPlanImplement(
			pi,
			"",
			"single",
			"current",
			"generic",
			false,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as ExtensionCommandContext,
		);
		assert.deepEqual(result, { handled: false });
	});

	it("allows only one listener to claim a request", () => {
		const request = {
			schemaVersion: 1 as const,
			payload: {
				task: "test",
				mode: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ "single" as DeliveryMode,
				workLocation:
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ "current" as WorkLocation,
				changeKind:
					/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ "generic" as ChangeKind,
				fast: false,
				ctx: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as ExtensionCommandContext,
			},
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
			claimPlanImplementRequest({ schemaVersion: 1, payload: { task: 42 }, claimed: false }, async () => {}),
			false,
		);
		assert.equal(
			claimPlanImplementRequest(
				{ schemaVersion: 1, payload: { task: "test", mode: "invalid" }, claimed: false },
				async () => {},
			),
			false,
		);
		assert.equal(
			claimPlanImplementRequest(
				{
					schemaVersion: 1,
					payload: {
						task: "test",
						mode: "stack",
						workLocation: "worktree",
						changeKind: "generic",
						fast: false,
						ctx: {},
					},
					claimed: false,
				},
				async () => {},
			),
			false,
		);
		assert.equal(
			claimPlanImplementRequest(
				{
					schemaVersion: 1,
					payload: {
						task: "test",
						mode: "stack",
						workLocation: "current",
						changeKind: "generic",
						fast: true,
						ctx: {},
					},
					claimed: false,
				},
				async () => {},
			),
			false,
		);
		assert.equal(
			claimPlanImplementRequest(
				{ schemaVersion: 2, payload: { task: "test", mode: "single" }, claimed: false },
				async () => {},
			),
			false,
		);
	});
});
