/** Typed in-process contract for invoking PR autopilot from another extension. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createRequestChannel, type RequestEnvelope } from "../shared/request-channel.ts";
import type { AutopilotResult } from "./driver.ts";
import type { AutopilotMode } from "./types.ts";

export const PRAUTOPILOT_REQUEST_EVENT = "kstack:pr-autopilot:request";
const MODES: ReadonlySet<string> = new Set(["check", "threads", "drive", "watch", "cleanup"]);

interface PrAutopilotPayload {
	mode: AutopilotMode;
	prNumber: number;
	ctx: ExtensionCommandContext;
	cwd?: string;
}

export interface PrAutopilotRequest extends RequestEnvelope<PrAutopilotPayload, AutopilotResult, 1> {}

const channel = createRequestChannel<PrAutopilotPayload, AutopilotResult, 1>({
	event: PRAUTOPILOT_REQUEST_EVENT,
	schemaVersion: 1,
	isPayload: (value): value is PrAutopilotPayload =>
		typeof value === "object" &&
		value !== null &&
		"mode" in value &&
		MODES.has(typeof value.mode === "string" ? value.mode : "") &&
		"prNumber" in value &&
		Number.isSafeInteger(value.prNumber) &&
		Number(value.prNumber) > 0 &&
		"ctx" in value &&
		typeof value.ctx === "object" &&
		value.ctx !== null &&
		(!("cwd" in value) || value.cwd === undefined || (typeof value.cwd === "string" && value.cwd.length > 0)),
});

export function isPrAutopilotRequest(value: unknown): value is PrAutopilotRequest {
	return channel.isRequest(value);
}

export function claimPrAutopilotRequest(
	value: unknown,
	run: (mode: AutopilotMode, prNumber: number, ctx: ExtensionCommandContext, cwd: string) => Promise<AutopilotResult>,
): boolean {
	return channel.claim(value, (payload) =>
		run(payload.mode, payload.prNumber, payload.ctx, payload.cwd ?? payload.ctx.cwd),
	);
}

export function requestPrAutopilot(
	pi: ExtensionAPI,
	mode: AutopilotMode,
	prNumber: number,
	ctx: ExtensionCommandContext,
	cwd?: string,
): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }> {
	return channel.request(pi, { mode, prNumber, ctx, cwd });
}
