/** Typed in-process contract for invoking PR autopilot from another extension. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import { type BoundaryValue, isObject, isString } from "../shared/validation.ts";
import { type AutopilotConfirmation, isAutopilotConfirmation } from "./confirmation.ts";
import type { AutopilotMode, AutopilotResult } from "./types.ts";

export { isAutopilotConfirmation, issueAutopilotConfirmation } from "./confirmation.ts";
export { isCodeReady } from "./pr-state.ts";
export type { AutopilotConfirmation } from "./types.ts";

export const PRAUTOPILOT_REQUEST_EVENT = "kstack:pr-autopilot:request";
const MODES: ReadonlySet<string> = new Set(["check", "threads", "drive", "watch", "cleanup"]);

interface PrAutopilotPayload {
	mode: AutopilotMode;
	prNumber?: number;
	ctx: ExtensionContext;
	cwd: string;
	/** Minted capability from a trusted caller that already holds user consent; skips run prompts. */
	confirmation?: AutopilotConfirmation;
	/** Optional abort signal from the calling lifecycle — composed into the run signal. */
	signal?: AbortSignal;
}

function isPositivePr(value: BoundaryValue): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isOptionalPr(value: BoundaryValue): value is number | undefined {
	return value === undefined || isPositivePr(value);
}

function isOptionalAbortSignal(value: BoundaryValue): value is AbortSignal | undefined {
	return value === undefined || value instanceof AbortSignal;
}

/* exported: request-channel contract */
export interface PrAutopilotRequest extends RequestEnvelope<PrAutopilotPayload, AutopilotResult, 1> {}

const channel = createRequestChannel<PrAutopilotPayload, AutopilotResult, 1>({
	event: PRAUTOPILOT_REQUEST_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is PrAutopilotPayload =>
		isObject(value) &&
		value !== null &&
		"mode" in value &&
		MODES.has(isString(value.mode) ? value.mode : "") &&
		(!("prNumber" in value) || isOptionalPr(value.prNumber)) &&
		(!("confirmation" in value) || value.confirmation === undefined || isAutopilotConfirmation(value.confirmation)) &&
		"ctx" in value &&
		isObject(value.ctx) &&
		value.ctx !== null &&
		"cwd" in value &&
		isString(value.cwd) &&
		value.cwd.length > 0 &&
		(!("signal" in value) || isOptionalAbortSignal(value.signal)),
});

/* exported: request-channel contract */
export function isPrAutopilotRequest(value: BoundaryValue): value is PrAutopilotRequest {
	return channel.isRequest(value);
}

export function claimPrAutopilotRequest(
	value: BoundaryValue,
	run: (
		mode: AutopilotMode,
		prNumber: number | undefined,
		ctx: ExtensionContext,
		cwd: string,
		confirmation: AutopilotConfirmation | undefined,
		signal: AbortSignal | undefined,
	) => Promise<AutopilotResult>,
): boolean {
	return channel.claim(value, (payload) =>
		run(payload.mode, payload.prNumber, payload.ctx, payload.cwd, payload.confirmation, payload.signal),
	);
}

export function requestPrAutopilot(
	pi: ExtensionAPI,
	mode: AutopilotMode,
	prNumber: number | undefined,
	ctx: ExtensionContext,
	cwd: string,
	confirmation?: AutopilotConfirmation,
	signal?: AbortSignal,
): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }> {
	if (prNumber !== undefined && !isPositivePr(prNumber)) return Promise.resolve({ handled: false });
	return channel.request(pi, {
		mode,
		prNumber,
		ctx,
		cwd,
		...(confirmation === undefined ? undefined : { confirmation }),
		...(signal === undefined ? undefined : { signal }),
	});
}
