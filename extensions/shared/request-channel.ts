/**
 * In-process request/claim channel for cross-extension invocation.
 *
 * The requester emits a mutable envelope on `pi.events`. A loaded target
 * claims it synchronously, exactly once, and attaches a completion promise.
 * An unclaimed emit means the target extension is not loaded.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BoundaryValue, isBoolean, isObject } from "./validation.ts";

export type RequestResponse<TResult> = { handled: false } | { handled: true; outcome: TResult };

export interface RequestEnvelope<TPayload, TResult, TVersion extends number = number> {
	schemaVersion: TVersion;
	payload: TPayload;
	claimed: boolean;
	completion?: Promise<TResult>;
}

interface ChannelSpec<TPayload, _TResult, TVersion extends number> {
	event: string;
	schemaVersion: TVersion;
	/** Validate the payload only; the channel validates envelope mechanics. */
	isPayload(value: BoundaryValue): value is TPayload;
}

export function createRequestChannel<TPayload, TResult, TVersion extends number>(
	spec: ChannelSpec<TPayload, TResult, TVersion>,
) {
	type Envelope = RequestEnvelope<TPayload, TResult, TVersion>;

	function isRequest(value: BoundaryValue): value is Envelope {
		if (!isObject(value) || value === null) return false;
		if (!("schemaVersion" in value) || value.schemaVersion !== spec.schemaVersion) return false;
		if (!("claimed" in value) || !isBoolean(value.claimed)) return false;
		return "payload" in value && spec.isPayload(value.payload);
	}

	function claim(value: BoundaryValue, run: (payload: TPayload) => Promise<TResult>): boolean {
		if (!isRequest(value) || value.claimed) return false;
		value.claimed = true;
		value.completion = run(value.payload);
		return true;
	}

	async function request(pi: ExtensionAPI, payload: TPayload): Promise<RequestResponse<TResult>> {
		const envelope: Envelope = { schemaVersion: spec.schemaVersion, payload, claimed: false };
		pi.events.emit(spec.event, envelope);
		if (!envelope.claimed || !envelope.completion) return { handled: false };
		return { handled: true, outcome: await envelope.completion };
	}

	return { event: spec.event, isRequest, claim, request };
}
