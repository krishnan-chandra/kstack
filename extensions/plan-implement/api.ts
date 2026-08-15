/** In-process request contract for invoking plan-implement from another extension. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ChangeKind, isChangeKind } from "../shared/change-kind.ts";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import type { DeliveryMode, WorkLocation } from "./types.ts";

export const PLAN_IMPLEMENT_REQUEST_EVENT = "kstack:plan-implement:request";

interface PlanImplementPayload {
	task: string;
	mode: DeliveryMode;
	workLocation: WorkLocation;
	changeKind: ChangeKind;
	ctx: ExtensionCommandContext;
}

/* exported: request-channel contract */
export interface PlanImplementRequest extends RequestEnvelope<PlanImplementPayload, void, 1> {}

function isWorkLocation(value: unknown): value is WorkLocation {
	return value === "current" || value === "worktree";
}

const channel = createRequestChannel<PlanImplementPayload, void, 1>({
	event: PLAN_IMPLEMENT_REQUEST_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is PlanImplementPayload =>
		typeof value === "object" &&
		value !== null &&
		"task" in value &&
		typeof value.task === "string" &&
		"ctx" in value &&
		typeof value.ctx === "object" &&
		value.ctx !== null &&
		"mode" in value &&
		(value.mode === "single" || value.mode === "stack") &&
		"workLocation" in value &&
		isWorkLocation(value.workLocation) &&
		!(value.mode === "stack" && value.workLocation === "worktree") &&
		"changeKind" in value &&
		typeof value.changeKind === "string" &&
		isChangeKind(value.changeKind),
});

/* exported: request-channel contract */
export function isPlanImplementRequest(value: unknown): value is PlanImplementRequest {
	return channel.isRequest(value);
}

export function claimPlanImplementRequest(
	value: unknown,
	run: (
		task: string,
		mode: DeliveryMode,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
	) => Promise<void>,
): boolean {
	return channel.claim(value, (payload) =>
		run(payload.task, payload.mode, payload.workLocation, payload.changeKind, payload.ctx),
	);
}

/**
 * Invoke the loaded plan-implement extension directly through Pi's event bus.
 * The mutable request is claimed synchronously; completion resolves when the
 * plan → approve → implement → panel-review workflow finishes.
 */
export async function requestPlanImplement(
	pi: ExtensionAPI,
	task: string,
	mode: DeliveryMode,
	workLocation: WorkLocation,
	changeKind: ChangeKind,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true } | { handled: false }> {
	const result = await channel.request(pi, { task, mode, workLocation, changeKind, ctx });
	return result.handled ? { handled: true } : { handled: false };
}
