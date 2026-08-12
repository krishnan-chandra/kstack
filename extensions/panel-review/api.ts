/** In-process request contract for invoking panel-review from another extension. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const PANEL_REVIEW_REQUEST_EVENT = "kstack:panel-review:request";

export interface PanelReviewRequest {
	schemaVersion: 1;
	args: string;
	ctx: ExtensionCommandContext;
	claimed: boolean;
	completion?: Promise<void>;
}

export function isPanelReviewRequest(value: unknown): value is PanelReviewRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<PanelReviewRequest>;
	return request.schemaVersion === 1 && typeof request.args === "string" && typeof request.ctx === "object" && request.ctx !== null;
}

export function claimPanelReviewRequest(
	value: unknown,
	run: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
): boolean {
	if (!isPanelReviewRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.args, value.ctx);
	return true;
}

/**
 * Invoke the loaded panel-review extension directly through Pi's event bus.
 * The mutable request is claimed synchronously; completion resolves when the
 * panel command workflow (including its own confirmation) finishes.
 */
export async function requestPanelReview(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true } | { handled: false }> {
	const request: PanelReviewRequest = { schemaVersion: 1, args, ctx, claimed: false };
	pi.events.emit(PANEL_REVIEW_REQUEST_EVENT, request);
	if (!request.claimed || !request.completion) return { handled: false };
	await request.completion;
	return { handled: true };
}
