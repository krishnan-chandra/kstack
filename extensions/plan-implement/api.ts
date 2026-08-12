/** In-process request contract for invoking plan-implement from another extension. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChangeKind } from "./change-kind.ts";
import { isChangeKind } from "./change-kind.ts";
import type { DeliveryMode } from "./types.ts";

export const PLAN_IMPLEMENT_REQUEST_EVENT = "kstack:plan-implement:request";

export interface PlanImplementRequest {
	schemaVersion: 1;
	task: string;
	mode: DeliveryMode;
	changeKind: ChangeKind;
	ctx: ExtensionCommandContext;
	claimed: boolean;
	completion?: Promise<void>;
}

export function isPlanImplementRequest(value: unknown): value is PlanImplementRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<PlanImplementRequest>;
	return (
		request.schemaVersion === 1 &&
		typeof request.task === "string" &&
		typeof request.ctx === "object" &&
		request.ctx !== null &&
		(request.mode === "single" || request.mode === "stack") &&
		typeof request.changeKind === "string" &&
		isChangeKind(request.changeKind)
	);
}

export function claimPlanImplementRequest(
	value: unknown,
	run: (task: string, mode: DeliveryMode, changeKind: ChangeKind, ctx: ExtensionCommandContext) => Promise<void>,
): boolean {
	if (!isPlanImplementRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.task, value.mode, value.changeKind, value.ctx);
	return true;
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
	changeKind: ChangeKind,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true } | { handled: false }> {
	const request: PlanImplementRequest = { schemaVersion: 1, task, mode, changeKind, ctx, claimed: false };
	pi.events.emit(PLAN_IMPLEMENT_REQUEST_EVENT, request);
	if (!request.claimed || !request.completion) return { handled: false };
	await request.completion;
	return { handled: true };
}