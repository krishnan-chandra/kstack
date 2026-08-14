/** Typed in-process contract for invoking PR autopilot from another extension. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutopilotResult } from "./driver.ts";
import type { AutopilotMode } from "./types.ts";

export const PRAUTOPILOT_REQUEST_EVENT = "kstack:pr-autopilot:request";
const MODES: ReadonlySet<string> = new Set(["check", "threads", "drive", "watch", "cleanup"]);

export interface PrAutopilotRequest {
	schemaVersion: 1;
	mode: AutopilotMode;
	prNumber: number;
	ctx: ExtensionCommandContext;
	cwd?: string;
	claimed: boolean;
	completion?: Promise<AutopilotResult>;
}

export function isPrAutopilotRequest(value: unknown): value is PrAutopilotRequest {
	if (typeof value !== "object" || value === null) return false;
	const request = value as Partial<PrAutopilotRequest>;
	return (
		request.schemaVersion === 1 &&
		MODES.has(request.mode ?? "") &&
		Number.isSafeInteger(request.prNumber) &&
		(request.prNumber ?? 0) > 0 &&
		typeof request.ctx === "object" &&
		request.ctx !== null &&
		(request.cwd === undefined || (typeof request.cwd === "string" && request.cwd.length > 0)) &&
		typeof request.claimed === "boolean"
	);
}

export function claimPrAutopilotRequest(
	value: unknown,
	run: (mode: AutopilotMode, prNumber: number, ctx: ExtensionCommandContext, cwd: string) => Promise<AutopilotResult>,
): boolean {
	if (!isPrAutopilotRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.mode, value.prNumber, value.ctx, value.cwd ?? value.ctx.cwd);
	return true;
}

export async function requestPrAutopilot(
	pi: ExtensionAPI,
	mode: AutopilotMode,
	prNumber: number,
	ctx: ExtensionCommandContext,
	cwd?: string,
): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }> {
	const request: PrAutopilotRequest = { schemaVersion: 1, mode, prNumber, ctx, cwd, claimed: false };
	pi.events.emit(PRAUTOPILOT_REQUEST_EVENT, request);
	if (!request.claimed || !request.completion) return { handled: false };
	return { handled: true, outcome: await request.completion };
}
