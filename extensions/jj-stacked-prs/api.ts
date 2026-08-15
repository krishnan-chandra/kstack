/** Capability probe and typed publication request channels. */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import {
	type JjStackCapabilities,
	MAX_NAME_CHARS,
	MAX_REVSET_CHARS,
	SCHEMA_VERSION,
	type StackLandingRequestInput,
	type StackPrefixLandOutcome,
	type StackPublicationOutcome,
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
export interface JjStackPublicationRequest extends RequestEnvelope<PublicationPayload, StackPublicationOutcome, 1> {}
/* exported: request-channel contract */
export interface JjStackLandingRequest extends RequestEnvelope<LandingPayload, StackPrefixLandOutcome, 1> {}

const capabilityChannel = createRequestChannel<CapabilityPayload, JjStackCapabilities, 1>({
	event: JJ_STACK_CAPABILITIES_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is CapabilityPayload =>
		typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === SCHEMA_VERSION,
});

const publicationChannel = createRequestChannel<PublicationPayload, StackPublicationOutcome, 1>({
	event: JJ_STACK_PUBLICATION_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is PublicationPayload => {
		if (typeof value !== "object" || value === null || !("input" in value) || !("ctx" in value)) return false;
		if (typeof value.ctx !== "object" || value.ctx === null) return false;
		return isPublicationInput(value.input);
	},
});

const landingChannel = createRequestChannel<LandingPayload, StackPrefixLandOutcome, 1>({
	event: JJ_STACK_LANDING_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is LandingPayload => {
		if (typeof value !== "object" || value === null || !("input" in value) || !("ctx" in value)) return false;
		if (typeof value.ctx !== "object" || value.ctx === null) return false;
		return isLandingInput(value.input);
	},
});

export function isJjStackCapabilitiesRequest(value: unknown): value is JjStackCapabilitiesRequest {
	return capabilityChannel.isRequest(value);
}

export function claimJjStackCapabilities(value: unknown, run: () => Promise<JjStackCapabilities>): boolean {
	return capabilityChannel.claim(value, () => run());
}

export function requestJjStackCapabilities(
	pi: ExtensionAPI,
): Promise<{ handled: false } | { handled: true; outcome: JjStackCapabilities }> {
	return capabilityChannel.request(pi, { schemaVersion: SCHEMA_VERSION });
}

export function isJjStackPublicationRequest(value: unknown): value is JjStackPublicationRequest {
	return publicationChannel.isRequest(value);
}

export function claimStackPublication(
	value: unknown,
	run: (input: StackPublicationRequestInput, ctx: ExtensionCommandContext) => Promise<StackPublicationOutcome>,
): boolean {
	return publicationChannel.claim(value, ({ input, ctx }) => run(input, ctx));
}

export function requestStackPublication(
	pi: ExtensionAPI,
	input: StackPublicationRequestInput,
	ctx: ExtensionCommandContext,
): Promise<{ handled: false } | { handled: true; outcome: StackPublicationOutcome }> {
	return publicationChannel.request(pi, { input, ctx });
}

export function isJjStackLandingRequest(value: unknown): value is JjStackLandingRequest {
	return landingChannel.isRequest(value);
}

export function claimStackLanding(
	value: unknown,
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

function isPublicationInput(value: unknown): value is StackPublicationRequestInput {
	if (typeof value !== "object" || value === null || !("repositoryPath" in value)) return false;
	const input = value as Record<string, unknown>;
	if (typeof input.repositoryPath !== "string" || input.repositoryPath.length === 0) return false;
	if (input.trunkRevset !== undefined && !optionalName(input.trunkRevset, MAX_REVSET_CHARS)) return false;
	if (input.topBookmark !== undefined && !optionalName(input.topBookmark, MAX_NAME_CHARS)) return false;
	if (input.remote !== undefined && !optionalName(input.remote, MAX_NAME_CHARS)) return false;
	if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) return false;
	return true;
}

function isLandingInput(value: unknown): value is StackLandingRequestInput {
	if (typeof value !== "object" || value === null || !("repositoryPath" in value)) return false;
	const input = value as Record<string, unknown>;
	if (typeof input.repositoryPath !== "string" || input.repositoryPath.length === 0) return false;
	if (!Number.isSafeInteger(input.prNumber) || Number(input.prNumber) <= 0) return false;
	if (!optionalName(input.headBookmark, MAX_NAME_CHARS)) return false;
	if (input.readiness !== "check" && input.readiness !== "watch") return false;
	if (input.method !== undefined && input.method !== "squash" && input.method !== "rebase") return false;
	return true;
}

function optionalName(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\n\r]/.test(value);
}
