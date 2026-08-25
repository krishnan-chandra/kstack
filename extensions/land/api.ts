import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAutopilotConfirmation } from "../pr-autopilot/api.ts";
import { isMergeMethod } from "../shared/github.ts";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import { type BoundaryValue, isObject, isString } from "../shared/validation.ts";
import { isLandConfirmation } from "./confirmation.ts";
import type { LandOptions, LandResult } from "./types.ts";

// Public in-process access to Land's per-repository merge policy.
export { getRepoMethod, loadLandConfig } from "./config.ts";

export const LAND_REQUEST_EVENT = "kstack:land:request";
const READINESS_MODES = new Set<unknown>(["check", "watch"]);

interface LandPayload {
	options: LandOptions;
	ctx: ExtensionContext;
}

/* exported: request-channel contract */
export interface LandRequest extends RequestEnvelope<LandPayload, LandResult, 1> {}

const channel = createRequestChannel<LandPayload, LandResult, 1>({
	event: LAND_REQUEST_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is LandPayload => {
		if (!isObject(value) || value === null || !("options" in value) || !("ctx" in value)) return false;
		const options = value.options;
		if (!isObject(value.ctx) || value.ctx === null || !isObject(options) || options === null) return false;
		if ("cwd" in options && options.cwd !== undefined && (!isString(options.cwd) || options.cwd.length === 0))
			return false;
		if ("confirmation" in options && options.confirmation !== undefined && !isLandConfirmation(options.confirmation))
			return false;
		if (
			"autopilotConfirmation" in options &&
			options.autopilotConfirmation !== undefined &&
			!isAutopilotConfirmation(options.autopilotConfirmation)
		)
			return false;
		if (
			!("readiness" in options) ||
			!READINESS_MODES.has(options.readiness) ||
			("method" in options && options.method !== undefined && !isMergeMethod(options.method))
		)
			return false;
		if (!("target" in options)) return false;
		const target = options.target;
		return (
			isObject(target) &&
			target !== null &&
			"kind" in target &&
			target.kind === "single" &&
			"prNumber" in target &&
			Number.isSafeInteger(target.prNumber) &&
			Number(target.prNumber) > 0
		);
	},
});

export function isLandRequest(value: BoundaryValue): value is LandRequest {
	return channel.isRequest(value);
}

export function claimLandRequest(
	value: BoundaryValue,
	run: (options: LandOptions, ctx: ExtensionContext) => Promise<LandResult>,
): boolean {
	return channel.claim(value, ({ options, ctx }) => run(options, ctx));
}

export function requestLand(
	pi: ExtensionAPI,
	options: LandOptions,
	ctx: ExtensionContext,
): Promise<{ handled: false } | { handled: true; outcome: LandResult }> {
	return channel.request(pi, { options, ctx });
}
