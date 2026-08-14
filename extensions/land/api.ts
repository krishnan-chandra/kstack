import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LandOptions, LandResult } from "./types.ts";
export const LAND_REQUEST_EVENT = "kstack:land:request";
export interface LandRequest {
	schemaVersion: 1;
	options: LandOptions;
	ctx: ExtensionCommandContext;
	claimed: boolean;
	completion?: Promise<LandResult>;
}
export function isLandRequest(value: unknown): value is LandRequest {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<LandRequest>;
	const o = r.options;
	if (
		r.schemaVersion !== 1 ||
		typeof r.claimed !== "boolean" ||
		typeof r.ctx !== "object" ||
		r.ctx === null ||
		typeof o !== "object" ||
		o === null
	)
		return false;
	if (o.cwd !== undefined && (typeof o.cwd !== "string" || o.cwd.length === 0)) return false;
	if (
		!(["check", "watch"] as unknown[]).includes(o.readiness) ||
		(o.method !== undefined && !(["merge", "squash", "rebase"] as unknown[]).includes(o.method))
	)
		return false;
	return o.target?.kind === "single" && Number.isSafeInteger(o.target.prNumber) && o.target.prNumber > 0;
}
export function claimLandRequest(
	value: unknown,
	run: (options: LandOptions, ctx: ExtensionCommandContext) => Promise<LandResult>,
): boolean {
	if (!isLandRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.options, value.ctx);
	return true;
}
export async function requestLand(
	pi: ExtensionAPI,
	options: LandOptions,
	ctx: ExtensionCommandContext,
): Promise<{ handled: false } | { handled: true; outcome: LandResult }> {
	const request: LandRequest = { schemaVersion: 1, options, ctx, claimed: false };
	pi.events.emit(LAND_REQUEST_EVENT, request);
	if (!request.claimed || !request.completion) return { handled: false };
	return { handled: true, outcome: await request.completion };
}
