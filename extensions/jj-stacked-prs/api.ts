import { type BoundaryValue, isObject, isString, type JsonObject } from "../shared/validation.ts";
/** Capability probe and typed publication request channels. */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMergeMethod } from "../shared/github.ts";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import type { StackPrefixLandOutcome, StackPublishOutcome } from "../shared/stack/outcome.ts";
import {
	type JjStackCapabilities,
	MAX_NAME_CHARS,
	MAX_REVSET_CHARS,
	SCHEMA_VERSION,
	type StackLandingRequestInput,
	type StackPublicationRequestInput,
} from "./types.ts";

export const JJ_STACK_CAPABILITIES_EVENT = "kstack:jj-stack:capabilities";
export const JJ_STACK_PUBLICATION_EVENT = "kstack:jj-stack:publish";
export const JJ_STACK_LANDING_EVENT = "kstack:jj-stack:land-through-pr";

export const JJ_STACK_CAPABILITIES: JjStackCapabilities = {
	schemaVersion: SCHEMA_VERSION,
	commands: ["inspect", "plan", "publish", "sync", "advance", "land"],
	tools: ["jj_stack_inspect", "jj_stack_plan", "jj_stack_publish", "jj_stack_land"],
	publication: true,
};

interface CapabilityPayload {
	schemaVersion: typeof SCHEMA_VERSION;
}

interface PublicationPayload {
	input: StackPublicationRequestInput;
	ctx: ExtensionCommandContext;
}

interface LandingPayload {
	input: StackLandingRequestInput;
	ctx: ExtensionContext;
}

/* exported: request-channel contract */
export interface JjStackCapabilitiesRequest extends RequestEnvelope<CapabilityPayload, JjStackCapabilities, 1> {}
/* exported: request-channel contract */
export interface JjStackPublicationRequest extends RequestEnvelope<PublicationPayload, StackPublishOutcome, 1> {}
/* exported: request-channel contract */
export interface JjStackLandingRequest extends RequestEnvelope<LandingPayload, StackPrefixLandOutcome, 1> {}

const capabilityChannel = createRequestChannel<CapabilityPayload, JjStackCapabilities, 1>({
	event: JJ_STACK_CAPABILITIES_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is CapabilityPayload =>
		isObject(value) && value !== null && "schemaVersion" in value && value.schemaVersion === SCHEMA_VERSION,
});

const publicationChannel = createRequestChannel<PublicationPayload, StackPublishOutcome, 1>({
	event: JJ_STACK_PUBLICATION_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is PublicationPayload => {
		if (!isObject(value) || value === null || !("input" in value) || !("ctx" in value)) return false;
		if (!isObject(value.ctx) || value.ctx === null) return false;
		return isPublicationInput(value.input);
	},
});

const landingChannel = createRequestChannel<LandingPayload, StackPrefixLandOutcome, 1>({
	event: JJ_STACK_LANDING_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is LandingPayload => {
		if (!isObject(value) || value === null || !("input" in value) || !("ctx" in value)) return false;
		if (!isObject(value.ctx) || value.ctx === null) return false;
		return isLandingInput(value.input);
	},
});

export function isJjStackCapabilitiesRequest(value: BoundaryValue): value is JjStackCapabilitiesRequest {
	return capabilityChannel.isRequest(value);
}

export function claimJjStackCapabilities(value: BoundaryValue, run: () => Promise<JjStackCapabilities>): boolean {
	return capabilityChannel.claim(value, () => run());
}

export function requestJjStackCapabilities(
	pi: ExtensionAPI,
): Promise<{ handled: false } | { handled: true; outcome: JjStackCapabilities }> {
	return capabilityChannel.request(pi, { schemaVersion: SCHEMA_VERSION });
}

export function isJjStackPublicationRequest(value: BoundaryValue): value is JjStackPublicationRequest {
	return publicationChannel.isRequest(value);
}

export function claimStackPublication(
	value: BoundaryValue,
	run: (input: StackPublicationRequestInput, ctx: ExtensionCommandContext) => Promise<StackPublishOutcome>,
): boolean {
	return publicationChannel.claim(value, ({ input, ctx }) => run(input, ctx));
}

export function requestStackPublication(
	pi: ExtensionAPI,
	input: StackPublicationRequestInput,
	ctx: ExtensionCommandContext,
): Promise<{ handled: false } | { handled: true; outcome: StackPublishOutcome }> {
	return publicationChannel.request(pi, { input, ctx });
}

export function isJjStackLandingRequest(value: BoundaryValue): value is JjStackLandingRequest {
	return landingChannel.isRequest(value);
}

export function claimStackLanding(
	value: BoundaryValue,
	run: (input: StackLandingRequestInput, ctx: ExtensionContext) => Promise<StackPrefixLandOutcome>,
): boolean {
	return landingChannel.claim(value, ({ input, ctx }) => run(input, ctx));
}

export function requestStackLanding(
	pi: ExtensionAPI,
	input: StackLandingRequestInput,
	ctx: ExtensionContext,
): Promise<{ handled: false } | { handled: true; outcome: StackPrefixLandOutcome }> {
	return landingChannel.request(pi, { input, ctx });
}

function isPublicationInput(value: BoundaryValue): value is StackPublicationRequestInput {
	if (!isObject(value) || value === null || !("repositoryPath" in value)) return false;
	const input =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ value as JsonObject;
	if (!isString(input.repositoryPath) || input.repositoryPath.length === 0) return false;
	if (input.trunkRevset !== undefined && !optionalName(input.trunkRevset, MAX_REVSET_CHARS)) return false;
	if (input.topBookmark !== undefined && !optionalName(input.topBookmark, MAX_NAME_CHARS)) return false;
	if (input.remote !== undefined && !optionalName(input.remote, MAX_NAME_CHARS)) return false;
	if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) return false;
	return true;
}

function isLandingInput(value: BoundaryValue): value is StackLandingRequestInput {
	if (!isObject(value) || value === null || !("repositoryPath" in value)) return false;
	const input =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ value as JsonObject;
	if (!isString(input.repositoryPath) || input.repositoryPath.length === 0) return false;
	if (!Number.isSafeInteger(input.prNumber) || Number(input.prNumber) <= 0) return false;
	if (!optionalName(input.headBookmark, MAX_NAME_CHARS)) return false;
	if (input.readiness !== "check" && input.readiness !== "watch") return false;
	if (input.method !== undefined && !isMergeMethod(input.method)) return false;
	return true;
}

function optionalName(value: BoundaryValue, max: number): value is string {
	return isString(value) && value.length > 0 && value.length <= max && !/[\0\n\r]/.test(value);
}
