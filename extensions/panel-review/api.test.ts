import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { claimPanelReviewRequest, PANEL_REVIEW_REQUEST_EVENT, requestPanelReview } from "./api.ts";

function fakeBus(listener?: (data: unknown) => void) {
	return {
		emit(channel: string, data: unknown) {
			assert.equal(channel, PANEL_REVIEW_REQUEST_EVENT);
			listener?.(data);
		},
		on() { return () => {}; },
	};
}

describe("panel-review in-process API", () => {
	it("passes structured options and awaits the panel handler", async () => {
		const calls: unknown[] = [];
		const ctx = {} as ExtensionCommandContext;
		const pi = {
			events: fakeBus((data) => {
				claimPanelReviewRequest(data, async (options, receivedCtx) => {
					assert.equal(receivedCtx, ctx);
					calls.push(options);
				});
			}),
		} as unknown as ExtensionAPI;
		const result = await requestPanelReview(pi, { intent: 'quoted "text" \\ path', base: "origin/main" }, ctx);
		assert.deepEqual(result, { handled: true });
		assert.deepEqual(calls, [{ intent: 'quoted "text" \\ path', base: "origin/main" }]);
	});

	it("reports unavailable when panel-review has no listener", async () => {
		const pi = { events: fakeBus() } as unknown as ExtensionAPI;
		const result = await requestPanelReview(pi, {}, {} as ExtensionCommandContext);
		assert.deepEqual(result, { handled: false });
	});

	it("allows only one listener to claim a request", () => {
		const request = { schemaVersion: 2, options: {}, ctx: {} as ExtensionCommandContext, claimed: false };
		assert.equal(claimPanelReviewRequest(request, async () => {}), true);
		assert.equal(claimPanelReviewRequest(request, async () => { throw new Error("should not run"); }), false);
	});
});
