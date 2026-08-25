import { type BoundaryValue, isNumber, isObject, isString } from "../shared/validation.ts";
/** Typed in-process contract for invoking panel-review from another extension. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import type { PanelArgs, PanelReviewOutcome } from "./types.ts";

export const PANEL_REVIEW_REQUEST_EVENT = "kstack:panel-review:request";

interface PanelReviewPayload {
	options: PanelArgs;
	ctx: ExtensionCommandContext;
}

/* exported: request-channel contract */
export interface PanelReviewRequest extends RequestEnvelope<PanelReviewPayload, PanelReviewOutcome, 2> {}

const channel = createRequestChannel<PanelReviewPayload, PanelReviewOutcome, 2>({
	event: PANEL_REVIEW_REQUEST_EVENT,
	schemaVersion: 2,
	isPayload: (value): value is PanelReviewPayload => {
		if (!isObject(value) || value === null || !("options" in value) || !("ctx" in value)) return false;
		const options = value.options;
		return (
			isObject(options) &&
			options !== null &&
			!Array.isArray(options) &&
			(!("base" in options) || options.base === undefined || isString(options.base)) &&
			(!("pr" in options) ||
				options.pr === undefined ||
				(isNumber(options.pr) && Number.isSafeInteger(options.pr) && options.pr > 0)) &&
			!("base" in options && options.base !== undefined && "pr" in options && options.pr !== undefined) &&
			(!("intent" in options) || options.intent === undefined || isString(options.intent)) &&
			(!("repositoryPath" in options) || options.repositoryPath === undefined || isString(options.repositoryPath)) &&
			(!("approvedPlan" in options) || options.approvedPlan === undefined || isString(options.approvedPlan)) &&
			(!("executionLedger" in options) || options.executionLedger === undefined || isString(options.executionLedger)) &&
			isObject(value.ctx) &&
			value.ctx !== null
		);
	},
});

/* exported: request-channel contract */
export function isPanelReviewRequest(value: BoundaryValue): value is PanelReviewRequest {
	return channel.isRequest(value);
}

export function claimPanelReviewRequest(
	value: BoundaryValue,
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
