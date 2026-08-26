import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMergeMethod, type MergeMethod } from "../shared/github.ts";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import { type BoundaryValue, isNumber, isObject, isString } from "../shared/validation.ts";
import type { DelegatedFrontierResponse } from "./frontier-settlement.ts";
import type { LandOptions, LandResult } from "./types.ts";

// Public in-process access to Land's per-repository merge policy.
export { getRepoMethod, loadLandConfig } from "./config.ts";
export { applyDelegatedFrontierSettlement, type DelegatedFrontierResponse } from "./frontier-settlement.ts";

export const LAND_REQUEST_EVENT = "kstack:land:request";
const READINESS_MODES = new Set<unknown>(["check", "watch"]);
const HEAD_SHA = /^[0-9a-f]{40}$/;

interface InteractiveLandRequest {
	kind: "interactive";
	options: LandOptions;
	ctx: ExtensionContext;
}

interface StackFrontierLandRequest {
	kind: "stack-frontier";
	options: LandOptions & { method: MergeMethod };
	expectedHeadSha: string;
	signal?: AbortSignal;
	ctx: ExtensionContext;
}

export type LandRequestPayload = InteractiveLandRequest | StackFrontierLandRequest;

/* exported: request-channel contract */
export interface LandRequest extends RequestEnvelope<LandRequestPayload, LandResult, 1> {}

function isOptions(value: BoundaryValue, methodRequired: boolean): value is LandOptions & { method?: MergeMethod } {
	if (
		!isObject(value) ||
		value === null ||
		Object.keys(value).some((key) => key !== "target" && key !== "readiness" && key !== "method" && key !== "cwd")
	) {
		return false;
	}
	if ("cwd" in value && value.cwd !== undefined && (!isString(value.cwd) || value.cwd.length === 0)) return false;
	if (!("readiness" in value) || !READINESS_MODES.has(value.readiness)) return false;
	if (methodRequired) {
		if (!("method" in value) || !isMergeMethod(value.method)) return false;
	} else if ("method" in value && value.method !== undefined && !isMergeMethod(value.method)) return false;
	if (!("target" in value) || !isObject(value.target) || value.target === null) return false;
	const target = value.target;
	return (
		Object.keys(target).every((key) => key === "kind" || key === "prNumber") &&
		"kind" in target &&
		target.kind === "single" &&
		"prNumber" in target &&
		isNumber(target.prNumber) &&
		Number.isSafeInteger(target.prNumber) &&
		target.prNumber > 0
	);
}

const channel = createRequestChannel<LandRequestPayload, LandResult, 1>({
	event: LAND_REQUEST_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is LandRequestPayload => {
		if (!isObject(value) || value === null || !("kind" in value) || !("options" in value) || !("ctx" in value)) {
			return false;
		}
		if (!isObject(value.ctx) || value.ctx === null) return false;
		if (value.kind === "interactive") {
			return (
				Object.keys(value).every((key) => key === "kind" || key === "options" || key === "ctx") &&
				isOptions(value.options, false)
			);
		}
		if (value.kind === "stack-frontier") {
			return (
				Object.keys(value).every(
					(key) =>
						key === "kind" || key === "options" || key === "expectedHeadSha" || key === "signal" || key === "ctx",
				) &&
				isOptions(value.options, true) &&
				"expectedHeadSha" in value &&
				isString(value.expectedHeadSha) &&
				HEAD_SHA.test(value.expectedHeadSha) &&
				(!("signal" in value) || value.signal === undefined || value.signal instanceof AbortSignal)
			);
		}
		return false;
	},
});

export function isLandRequest(value: BoundaryValue): value is LandRequest {
	return channel.isRequest(value);
}

export function claimLandRequest(
	value: BoundaryValue,
	run: (request: LandRequestPayload) => Promise<LandResult>,
): boolean {
	return channel.claim(value, run);
}

export function requestLand(
	pi: ExtensionAPI,
	options: LandOptions,
	ctx: ExtensionContext,
): Promise<{ handled: false } | { handled: true; outcome: LandResult }> {
	return channel.request(pi, { kind: "interactive", options, ctx });
}

export function requestStackFrontierLand(
	pi: ExtensionAPI,
	request: Omit<StackFrontierLandRequest, "kind">,
): Promise<DelegatedFrontierResponse> {
	return channel.request(pi, { kind: "stack-frontier", ...request });
}
