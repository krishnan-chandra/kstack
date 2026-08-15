import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import { isLandConfirmation } from "./confirmation.ts";
import type { LandOptions, LandResult } from "./types.ts";

export const LAND_REQUEST_EVENT = "kstack:land:request";
const READINESS_MODES = new Set<unknown>(["check", "watch"]);
const MERGE_METHODS = new Set<unknown>(["squash", "rebase"]);

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
		if (typeof value !== "object" || value === null || !("options" in value) || !("ctx" in value)) return false;
		const options = value.options;
		if (typeof value.ctx !== "object" || value.ctx === null || typeof options !== "object" || options === null)
			return false;
		if ("cwd" in options && options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.length === 0))
			return false;
		if ("confirmation" in options && options.confirmation !== undefined && !isLandConfirmation(options.confirmation))
			return false;
		if (
			!("readiness" in options) ||
			!READINESS_MODES.has(options.readiness) ||
			("method" in options && options.method !== undefined && !MERGE_METHODS.has(options.method))
		)
			return false;
		if (!("target" in options)) return false;
		const target = options.target;
		return (
			typeof target === "object" &&
			target !== null &&
			"kind" in target &&
			target.kind === "single" &&
			"prNumber" in target &&
			Number.isSafeInteger(target.prNumber) &&
			Number(target.prNumber) > 0
		);
	},
});

export function isLandRequest(value: unknown): value is LandRequest {
	return channel.isRequest(value);
}

export function claimLandRequest(
	value: unknown,
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
