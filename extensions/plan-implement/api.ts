/** In-process request contract for invoking plan-implement from another extension. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChangeKind } from "./change-kind.ts";
import { isChangeKind } from "./change-kind.ts";
import type { DeliveryMode, WorkLocation } from "./types.ts";

export const PLAN_IMPLEMENT_REQUEST_EVENT = "kstack:plan-implement:request";

export interface PlanImplementRequest {
	schemaVersion: 1;
	task: string;
	mode: DeliveryMode;
	/** Omitted by pre-worktree callers; omission means the current working tree. */
	workLocation?: WorkLocation;
	changeKind: ChangeKind;
	ctx: ExtensionCommandContext;
	claimed: boolean;
	completion?: Promise<void>;
}

function isWorkLocation(value: unknown): value is WorkLocation {
	return value === "current" || value === "worktree";
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
		(request.workLocation === undefined || isWorkLocation(request.workLocation)) &&
		!(request.mode === "stack" && request.workLocation === "worktree") &&
		typeof request.changeKind === "string" &&
		isChangeKind(request.changeKind)
	);
}

export function claimPlanImplementRequest(
	value: unknown,
	run: (task: string, mode: DeliveryMode, workLocation: WorkLocation, changeKind: ChangeKind, ctx: ExtensionCommandContext) => Promise<void>,
): boolean {
	if (!isPlanImplementRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.task, value.mode, value.workLocation ?? "current", value.changeKind, value.ctx);
	return true;
}

/** Backward-compatible signature used before managed worktree support. */
export function requestPlanImplement(
	pi: ExtensionAPI,
	task: string,
	mode: DeliveryMode,
	changeKind: ChangeKind,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true } | { handled: false }>;
/** Signature with an explicit execution location. */
export function requestPlanImplement(
	pi: ExtensionAPI,
	task: string,
	mode: DeliveryMode,
	workLocation: WorkLocation,
	changeKind: ChangeKind,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true } | { handled: false }>;
/**
 * Invoke the loaded plan-implement extension directly through Pi's event bus.
 * The mutable request is claimed synchronously; completion resolves when the
 * plan → approve → implement → panel-review workflow finishes.
 */
export async function requestPlanImplement(
	pi: ExtensionAPI,
	task: string,
	mode: DeliveryMode,
	workLocationOrChangeKind: WorkLocation | ChangeKind,
	changeKindOrCtx: ChangeKind | ExtensionCommandContext,
	maybeCtx?: ExtensionCommandContext,
): Promise<{ handled: true } | { handled: false }> {
	const modern = isWorkLocation(workLocationOrChangeKind);
	const workLocation: WorkLocation = modern ? workLocationOrChangeKind : "current";
	const changeKind = modern ? changeKindOrCtx : workLocationOrChangeKind;
	const ctx = modern ? maybeCtx : changeKindOrCtx;
	if (!isChangeKind(changeKind) || typeof ctx !== "object" || ctx === null) return { handled: false };
	const request: PlanImplementRequest = { schemaVersion: 1, task, mode, workLocation, changeKind, ctx, claimed: false };
	pi.events.emit(PLAN_IMPLEMENT_REQUEST_EVENT, request);
	if (!request.claimed || !request.completion) return { handled: false };
	await request.completion;
	return { handled: true };
}
