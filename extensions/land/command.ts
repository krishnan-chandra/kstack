import type { MergeMethod, ReadinessMode } from "./types.ts";
export interface LandArgs { pr?: number; top?: string; method?: MergeMethod; readiness: ReadinessMode }
const METHODS = new Set(["merge", "squash", "rebase"]);
const READINESS = new Set(["check", "watch"]);
const BOOKMARK = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
export function parseLandArgs(text: string): { ok: true; args: LandArgs } | { ok: false; error: string } {
	const tokens = text.trim() ? text.trim().split(/\s+/) : [];
	const args: LandArgs = { readiness: "check" };
	for (let i = 0; i < tokens.length; i++) {
		const flag = tokens[i]; const value = tokens[++i];
		if (!value) return { ok: false, error: `Missing value for ${flag}.` };
		if (flag === "--pr") { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, error: "--pr must be a positive integer." }; args.pr = n; }
		else if (flag === "--top") { if (!BOOKMARK.test(value)) return { ok: false, error: "--top is not a valid bookmark name." }; args.top = value; }
		else if (flag === "--method") { if (!METHODS.has(value)) return { ok: false, error: "--method must be merge, squash, or rebase." }; args.method = value as MergeMethod; }
		else if (flag === "--readiness") { if (!READINESS.has(value)) return { ok: false, error: "--readiness must be check or watch." }; args.readiness = value as ReadinessMode; }
		else return { ok: false, error: `Unknown option: ${flag}.` };
	}
	return { ok: true, args };
}
