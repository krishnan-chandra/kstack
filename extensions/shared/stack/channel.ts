/**
 * Request/claim channels for cross-extension stack provider operations.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isMergeMethod, type MergeMethod } from "../github.ts";
import { createRequestChannel, type RequestEnvelope } from "../request-channel.ts";
import type { BoundaryValue, JsonObject } from "../validation.ts";
import { isObject, isString } from "../validation.ts";
import type { VcsResult } from "../vcs/backend.ts";
import type { StackPrefixLandOutcome, StackPublishOutcome } from "./outcome.ts";
import type { StackProviderId } from "./provider.ts";

export const STACK_CAPABILITIES_EVENT = "kstack:stack:capabilities";
export const STACK_PREFLIGHT_EVENT = "kstack:stack:preflight";
export const STACK_PUBLICATION_EVENT = "kstack:stack:publish";
export const STACK_LANDING_EVENT = "kstack:stack:land-through-pr";

export interface StackProviderCapabilities {
	schemaVersion: 1;
	publication: boolean;
	commands?: readonly string[];
	tools?: readonly string[];
}

/* exported: request-channel contract */
export interface StackCapabilitiesPayload {
	provider: StackProviderId;
}

export interface StackPreflight {
	workspaceRoot: string;
	trunkRef: string;
	trunkSha: string;
	childPolicy: string;
}

/* exported: request-channel contract */
export interface StackPreflightPayload {
	provider: StackProviderId;
	cwd: string;
	manifestPath?: string;
}

export interface StackPublicationRequestInput {
	repositoryPath: string;
	trunk?: string;
	topRef?: string;
	remote?: string;
	manifestPath?: string;
	signal?: AbortSignal;
}

/* exported: request-channel contract */
export interface StackPublicationPayload {
	provider: StackProviderId;
	input: StackPublicationRequestInput;
	ctx: ExtensionCommandContext;
}

export interface StackLandingRequestInput {
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

/* exported: request-channel contract */
export interface StackCapabilitiesRequest
	extends RequestEnvelope<StackCapabilitiesPayload, StackProviderCapabilities, 1> {}
/* exported: request-channel contract */
export interface StackPreflightRequest extends RequestEnvelope<StackPreflightPayload, VcsResult<StackPreflight>, 1> {}
/* exported: request-channel contract */
export interface StackPublicationRequest extends RequestEnvelope<StackPublicationPayload, StackPublishOutcome, 1> {}
/* exported: request-channel contract */
export interface StackLandingRequest extends RequestEnvelope<StackLandingPayload, StackPrefixLandOutcome, 1> {}

function isProvider(value: BoundaryValue): value is StackProviderId {
	return value === "jj" || value === "graphite";
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

function isPublicationInput(value: BoundaryValue): value is StackPublicationRequestInput {
	if (!isObject(value) || value === null || !("repositoryPath" in value)) return false;
	const input = /* SAFETY: isObject established the validated boundary representation. */ value as JsonObject;
	if (!isString(input.repositoryPath) || input.repositoryPath.length === 0) return false;
	if (input.trunk !== undefined && !isSafeRef(input.trunk, 1024)) return false;
	if (input.topRef !== undefined && !isSafeRef(input.topRef)) return false;
	if (input.remote !== undefined && !isSafeRef(input.remote)) return false;
	if (input.manifestPath !== undefined && (!isString(input.manifestPath) || input.manifestPath.length === 0))
		return false;
	if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) return false;
	return true;
}

const capabilityChannel = createRequestChannel<StackCapabilitiesPayload, StackProviderCapabilities, 1>({
	event: STACK_CAPABILITIES_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is StackCapabilitiesPayload =>
		isObject(value) && value !== null && "provider" in value && isProvider(value.provider),
});

const preflightChannel = createRequestChannel<StackPreflightPayload, VcsResult<StackPreflight>, 1>({
	event: STACK_PREFLIGHT_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is StackPreflightPayload => {
		if (!isObject(value) || value === null || !("provider" in value) || !isProvider(value.provider)) return false;
		if (!("cwd" in value) || !isString(value.cwd) || value.cwd.length === 0) return false;
		if ("manifestPath" in value && value.manifestPath !== undefined) {
			if (!isString(value.manifestPath) || value.manifestPath.length === 0) return false;
		}
		return true;
	},
});

const publicationChannel = createRequestChannel<StackPublicationPayload, StackPublishOutcome, 1>({
	event: STACK_PUBLICATION_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is StackPublicationPayload => {
		if (!isObject(value) || value === null || !("provider" in value) || !isProvider(value.provider)) return false;
		if (!("input" in value) || !isPublicationInput(value.input)) return false;
		if (!("ctx" in value) || !isObject(value.ctx) || value.ctx === null) return false;
		return true;
	},
});

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

export function isStackCapabilitiesRequest(value: BoundaryValue): value is StackCapabilitiesRequest {
	return capabilityChannel.isRequest(value);
}

export function claimStackCapabilities(
	value: BoundaryValue,
	provider: StackProviderId,
	run: (payload: StackCapabilitiesPayload) => Promise<StackProviderCapabilities>,
): boolean {
	if (!capabilityChannel.isRequest(value) || value.payload.provider !== provider) return false;
	return capabilityChannel.claim(value, run);
}

export function requestStackCapabilities(
	pi: ExtensionAPI,
	provider: StackProviderId,
): Promise<{ handled: false } | { handled: true; outcome: StackProviderCapabilities }> {
	return capabilityChannel.request(pi, { provider });
}

export function isStackPreflightRequest(value: BoundaryValue): value is StackPreflightRequest {
	return preflightChannel.isRequest(value);
}

export function claimStackPreflight(
	value: BoundaryValue,
	provider: StackProviderId,
	run: (payload: StackPreflightPayload) => Promise<VcsResult<StackPreflight>>,
): boolean {
	if (!preflightChannel.isRequest(value) || value.payload.provider !== provider) return false;
	return preflightChannel.claim(value, run);
}

export function requestStackPreflight(
	pi: ExtensionAPI,
	payload: StackPreflightPayload,
): Promise<{ handled: false } | { handled: true; outcome: VcsResult<StackPreflight> }> {
	return preflightChannel.request(pi, payload);
}

export function isStackPublicationRequest(value: BoundaryValue): value is StackPublicationRequest {
	return publicationChannel.isRequest(value);
}

export function claimStackPublication(
	value: BoundaryValue,
	provider: StackProviderId,
	run: (input: StackPublicationRequestInput, ctx: ExtensionCommandContext) => Promise<StackPublishOutcome>,
): boolean {
	if (!publicationChannel.isRequest(value) || value.payload.provider !== provider) return false;
	return publicationChannel.claim(value, ({ input, ctx }) => run(input, ctx));
}

export function requestStackPublication(
	pi: ExtensionAPI,
	payload: { provider: StackProviderId; input: StackPublicationRequestInput; ctx: ExtensionCommandContext },
): Promise<{ handled: false } | { handled: true; outcome: StackPublishOutcome }> {
	return publicationChannel.request(pi, payload);
}

export function isStackLandingRequest(value: BoundaryValue): value is StackLandingRequest {
	return landingChannel.isRequest(value);
}

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
