import { type BoundaryValue, isBoolean, isObject, isString } from "../shared/validation.ts";
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
	/** When true, skip planner/panel-review/publisher and run one bounded implementer. */
	fast: boolean;
	/** Run the configured adversary debate before approval. */
	adversary: boolean;
	/** Stop after writing the final plan; do not create a workstream. */
	planOnly: boolean;
	ctx: ExtensionCommandContext;
}

/* exported: request-channel contract */
export interface PlanImplementRequest extends RequestEnvelope<PlanImplementPayload, void, 2> {}

function isWorkLocation(value: BoundaryValue): value is WorkLocation {
	return value === "current" || value === "worktree";
}

const channel = createRequestChannel<PlanImplementPayload, void, 2>({
	event: PLAN_IMPLEMENT_REQUEST_EVENT,
	schemaVersion: 2,
	isPayload: (value): value is PlanImplementPayload =>
		isObject(value) &&
		value !== null &&
		"task" in value &&
		isString(value.task) &&
		"ctx" in value &&
		isObject(value.ctx) &&
		value.ctx !== null &&
		"mode" in value &&
		(value.mode === "single" || value.mode === "stack") &&
		"workLocation" in value &&
		isWorkLocation(value.workLocation) &&
		!(value.mode === "stack" && value.workLocation === "worktree") &&
		"fast" in value &&
		isBoolean(value.fast) &&
		!(value.fast && value.mode === "stack") &&
		"adversary" in value &&
		isBoolean(value.adversary) &&
		"planOnly" in value &&
		isBoolean(value.planOnly) &&
		!(value.fast && value.planOnly) &&
		"changeKind" in value &&
		isString(value.changeKind) &&
		isChangeKind(value.changeKind),
});

export function claimPlanImplementRequest(
	value: BoundaryValue,
	run: (
		task: string,
		mode: DeliveryMode,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		fast: boolean,
		adversary: boolean,
		planOnly: boolean,
		ctx: ExtensionCommandContext,
	) => Promise<void>,
): boolean {
	return channel.claim(value, (payload) =>
		run(
			payload.task,
			payload.mode,
			payload.workLocation,
			payload.changeKind,
			payload.fast,
			payload.adversary,
			payload.planOnly,
			payload.ctx,
		),
	);
}

/**
 * Invoke the loaded plan-implement extension directly through Pi's event bus.
 * The mutable request is claimed synchronously; completion resolves when the
 * plan → approve → implement → panel-review workflow (or, with `fast`, the
 * single bounded implementer) finishes.
 */
export async function requestPlanImplement(
	pi: ExtensionAPI,
	task: string,
	mode: DeliveryMode,
	workLocation: WorkLocation,
	changeKind: ChangeKind,
	fast: boolean,
	adversary: boolean,
	planOnly: boolean,
	ctx: ExtensionCommandContext,
): Promise<{ handled: true } | { handled: false }> {
	const result = await channel.request(pi, { task, mode, workLocation, changeKind, fast, adversary, planOnly, ctx });
	return result.handled ? { handled: true } : { handled: false };
}
