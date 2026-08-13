/** Typed in-process contract for invoking panel-review from another extension. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PanelArgs, PanelReviewOutcome } from "./types.ts";

export const PANEL_REVIEW_REQUEST_EVENT = "kstack:panel-review:request";

export interface PanelReviewRequest {
	schemaVersion: 2;
	options: PanelArgs;
	ctx: ExtensionCommandContext;
	claimed: boolean;
	completion?: Promise<PanelReviewOutcome>;
}

export function isPanelReviewRequest(value: unknown): value is PanelReviewRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<PanelReviewRequest>;
	const options = request.options;
	return (
		request.schemaVersion === 2 &&
		typeof options === "object" &&
		options !== null &&
		!Array.isArray(options) &&
		(options.base === undefined || typeof options.base === "string") &&
		(options.intent === undefined || typeof options.intent === "string") &&
		(options.repositoryPath === undefined || typeof options.repositoryPath === "string") &&
		typeof request.ctx === "object" &&
		request.ctx !== null
	);
}

export function claimPanelReviewRequest(
	value: unknown,
	run: (options: PanelArgs, ctx: ExtensionCommandContext) => Promise<PanelReviewOutcome>,
): boolean {
	if (!isPanelReviewRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.options, value.ctx);
	return true;
}

/** Invoke panel-review without serializing structured values through command text. */
export async function requestPanelReview(
	pi: ExtensionAPI,
	options: PanelArgs,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true; outcome: PanelReviewOutcome } | { handled: false }> {
	const request: PanelReviewRequest = { schemaVersion: 2, options, ctx, claimed: false };
	pi.events.emit(PANEL_REVIEW_REQUEST_EVENT, request);
	if (!request.claimed || !request.completion) return { handled: false };
	const outcome = await request.completion;
	return { handled: true, outcome };
}
