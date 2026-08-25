import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BoundaryValue } from "../shared/validation.ts";
import { claimPanelReviewRequest, PANEL_REVIEW_REQUEST_EVENT, requestPanelReview } from "./api.ts";

function fakeBus(listener?: (data: BoundaryValue) => void) {
	return {
		emit(channel: string, data: BoundaryValue) {
			assert.equal(channel, PANEL_REVIEW_REQUEST_EVENT);
			listener?.(data);
		},
		on() {
			return () => {};
		},
	};
}

describe("panel-review in-process API", () => {
	it("passes structured options and awaits the panel handler's outcome", async () => {
		const calls: BoundaryValue[] = [];
		const ctx =
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as ExtensionCommandContext;
		const outcome = {
			status: "completed" as const,
			verdict: "Act On: one finding",
			synthesized: true,
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
		};
		const pi = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
			events: fakeBus((data) => {
				claimPanelReviewRequest(data, async (options, receivedCtx) => {
					assert.equal(receivedCtx, ctx);
					calls.push(options);
					return outcome;
				});
			}),
		} as never;
		const result = await requestPanelReview(
			pi,
			{ intent: 'quoted "text" \\ path', base: "origin/main", repositoryPath: "/managed/worktree" },
			ctx,
		);
		assert.deepEqual(result, { handled: true, outcome });
		assert.deepEqual(calls, [
			{ intent: 'quoted "text" \\ path', base: "origin/main", repositoryPath: "/managed/worktree" },
		]);
	});

	it("reports unavailable when panel-review has no listener", async () => {
		const pi = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
			events: fakeBus(),
		} as never;
		const result = await requestPanelReview(
			pi,
			{},
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as ExtensionCommandContext,
		);
		assert.deepEqual(result, { handled: false });
	});

	it("allows only one listener to claim a request", () => {
		const request = {
			schemaVersion: 2,
			payload: {
				options: {},
				ctx: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {} as ExtensionCommandContext,
			},
			claimed: false,
		};
		assert.equal(
			claimPanelReviewRequest(request, async () => ({ status: "declined" as const })),
			true,
		);
		assert.equal(
			claimPanelReviewRequest(request, async () => {
				throw new Error("should not run");
			}),
			false,
		);
	});
});
