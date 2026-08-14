/** Typed in-process contract for invoking panel-review from another extension. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import type { PanelArgs, PanelReviewOutcome } from "./types.ts";

export const PANEL_REVIEW_REQUEST_EVENT = "kstack:panel-review:request";

interface PanelReviewPayload {
	options: PanelArgs;
	ctx: ExtensionCommandContext;
}

export interface PanelReviewRequest extends RequestEnvelope<PanelReviewPayload, PanelReviewOutcome, 2> {}

const channel = createRequestChannel<PanelReviewPayload, PanelReviewOutcome, 2>({
	event: PANEL_REVIEW_REQUEST_EVENT,
	schemaVersion: 2,
	isPayload: (value): value is PanelReviewPayload => {
		if (typeof value !== "object" || value === null || !("options" in value) || !("ctx" in value)) return false;
		const options = value.options;
		return (
			typeof options === "object" &&
			options !== null &&
			!Array.isArray(options) &&
			(!("base" in options) || options.base === undefined || typeof options.base === "string") &&
			(!("intent" in options) || options.intent === undefined || typeof options.intent === "string") &&
			(!("repositoryPath" in options) ||
				options.repositoryPath === undefined ||
				typeof options.repositoryPath === "string") &&
			(!("approvedPlan" in options) ||
				options.approvedPlan === undefined ||
				typeof options.approvedPlan === "string") &&
			(!("executionLedger" in options) ||
				options.executionLedger === undefined ||
				typeof options.executionLedger === "string") &&
			typeof value.ctx === "object" &&
			value.ctx !== null
		);
	},
});

export function isPanelReviewRequest(value: unknown): value is PanelReviewRequest {
	return channel.isRequest(value);
}

export function claimPanelReviewRequest(
	value: unknown,
	run: (options: PanelArgs, ctx: ExtensionCommandContext) => Promise<PanelReviewOutcome>,
): boolean {
	return channel.claim(value, ({ options, ctx }) => run(options, ctx));
}

/** Invoke panel-review without serializing structured values through command text. */
export function requestPanelReview(
	pi: ExtensionAPI,
	options: PanelArgs,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true; outcome: PanelReviewOutcome } | { handled: false }> {
	return channel.request(pi, { options, ctx });
}
