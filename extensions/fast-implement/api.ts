import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isChangeKind, type ChangeKind } from "../shared/change-kind.ts";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";

export const FAST_IMPLEMENT_REQUEST_EVENT = "kstack:fast-implement:request";

type FastImplementWorkLocation = "current" | "worktree";

interface FastImplementPayload {
	task: string;
	workLocation: FastImplementWorkLocation;
	changeKind: ChangeKind;
	ctx: ExtensionCommandContext;
}

export interface FastImplementEvent extends RequestEnvelope<FastImplementPayload, void, 1> {}

const channel = createRequestChannel<FastImplementPayload, void, 1>({
	event: FAST_IMPLEMENT_REQUEST_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is FastImplementPayload =>
		typeof value === "object" &&
		value !== null &&
		"task" in value &&
		typeof value.task === "string" &&
		"workLocation" in value &&
		(value.workLocation === "current" || value.workLocation === "worktree") &&
		"changeKind" in value &&
		typeof value.changeKind === "string" &&
		isChangeKind(value.changeKind) &&
		"ctx" in value &&
		typeof value.ctx === "object" &&
		value.ctx !== null,
});

export function claimFastImplementRequest(
	value: unknown,
	run: (
		task: string,
		workLocation: FastImplementWorkLocation,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
	) => Promise<void>,
): boolean {
	return channel.claim(value, (payload) =>
		run(payload.task, payload.workLocation, payload.changeKind, payload.ctx),
	);
}

export async function requestFastImplement(
	pi: ExtensionAPI,
	task: string,
	workLocation: FastImplementWorkLocation,
	changeKind: ChangeKind,
	ctx: ExtensionCommandContext,
): Promise<{ handled: boolean }> {
	const result = await channel.request(pi, { task, workLocation, changeKind, ctx });
	return { handled: result.handled };
}
