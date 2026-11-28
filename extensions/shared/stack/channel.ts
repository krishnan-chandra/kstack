/**
 * Request/claim channels for cross-extension stack provider operations.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMergeMethod, type MergeMethod } from "../github.ts";
import { createRequestChannel } from "../request-channel.ts";
import type { BoundaryValue, JsonObject } from "../validation.ts";
import { isObject, isString } from "../validation.ts";
import type { StackPrefixLandOutcome } from "./outcome.ts";
import type { StackProviderId } from "./provider.ts";

export const STACK_LANDING_EVENT = "kstack:stack:land-through-pr";

interface StackLandingRequestInput {
	repositoryPath: string;
	prNumber: number;
	headRef: string;
	readiness: "check" | "watch";
	method?: MergeMethod;
	signal?: AbortSignal;
}

/* exported: request-channel contract */
export interface StackLandingCapabilities {
	runAutopilot?(mode: "check" | "watch", pr: number): Promise<{ handled: false } | { handled: true; outcome: unknown }>;
}

/* exported: request-channel contract */
export interface StackLandingPayload {
	provider: StackProviderId;
	input: StackLandingRequestInput;
	capabilities: StackLandingCapabilities;
	ctx: ExtensionContext;
}

function isProvider(value: BoundaryValue): value is StackProviderId {
	return value === "jj" || value === "graphite" || value === "github";
}

function isSafeRef(value: BoundaryValue, max = 240): value is string {
	return isString(value) && value.length > 0 && value.length <= max && !/[\0\n\r]/.test(value);
}

function isCapabilities(value: BoundaryValue): value is StackLandingCapabilities {
	if (!isObject(value) || value === null || Object.keys(value).some((key) => key !== "runAutopilot")) return false;
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Function identity is the complete in-process capability contract; invocation results stay unknown.
	if ("runAutopilot" in value && value.runAutopilot !== undefined && typeof value.runAutopilot !== "function")
		return false;
	return true;
}

function isLandingInput(value: BoundaryValue): value is StackLandingRequestInput {
	if (!isObject(value) || value === null || !("repositoryPath" in value)) return false;
	const input = /* SAFETY: isObject established the validated boundary representation. */ value as JsonObject;
	if (!isString(input.repositoryPath) || input.repositoryPath.length === 0) return false;
	if (!Number.isSafeInteger(input.prNumber) || Number(input.prNumber) <= 0) return false;
	if (!isSafeRef(input.headRef)) return false;
	if (input.readiness !== "check" && input.readiness !== "watch") return false;
	if (input.method !== undefined && !isMergeMethod(input.method)) return false;
	if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) return false;
	return true;
}

const landingChannel = createRequestChannel<StackLandingPayload, StackPrefixLandOutcome, 1>({
	event: STACK_LANDING_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is StackLandingPayload => {
		if (!isObject(value) || value === null || !("provider" in value) || !isProvider(value.provider)) return false;
		if (!("input" in value) || !isLandingInput(value.input)) return false;
		if (!("capabilities" in value) || !isCapabilities(value.capabilities)) return false;
		if (!("ctx" in value) || !isObject(value.ctx) || value.ctx === null) return false;
		return true;
	},
});

export function claimStackLanding(
	value: BoundaryValue,
	provider: StackProviderId,
	run: (payload: {
		input: StackLandingRequestInput;
		capabilities: StackLandingCapabilities;
		ctx: ExtensionContext;
	}) => Promise<StackPrefixLandOutcome>,
): boolean {
	if (!landingChannel.isRequest(value) || value.payload.provider !== provider) return false;
	return landingChannel.claim(value, run);
}

export function requestStackLanding(
	pi: ExtensionAPI,
	payload: {
		provider: StackProviderId;
		input: StackLandingRequestInput;
		capabilities: StackLandingCapabilities;
		ctx: ExtensionContext;
	},
): Promise<{ handled: false } | { handled: true; outcome: StackPrefixLandOutcome }> {
	return landingChannel.request(pi, payload);
}
