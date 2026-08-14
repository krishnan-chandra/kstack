import type { MergeMethod, ReadinessMode } from "./types.ts";
export interface LandArgs { pr?: number; method?: MergeMethod; readiness: ReadinessMode }
const METHODS: ReadonlySet<string> = new Set(["merge", "squash", "rebase"]);
const READINESS: ReadonlySet<string> = new Set(["check", "watch"]);
export function parseLandArgs(text: string): { ok: true; args: LandArgs } | { ok: false; error: string } {
	const tokens = text.trim() ? text.trim().split(/\s+/) : [];
	const args: LandArgs = { readiness: "check" };
	const seen = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const flag = tokens[i];
		if (seen.has(flag)) return { ok: false, error: `Duplicate option: ${flag}.` };
		seen.add(flag);
		const value = tokens[++i];
		if (!value) return { ok: false, error: `Missing value for ${flag}.` };
		if (flag === "--pr") {
			const number = Number(value);
			if (!Number.isSafeInteger(number) || number <= 0) return { ok: false, error: "--pr must be a positive integer." };
			args.pr = number;
		} else if (flag === "--method") {
			if (!METHODS.has(value)) return { ok: false, error: "--method must be merge, squash, or rebase." };
			if (value === "merge" || value === "squash" || value === "rebase") args.method = value;
		} else if (flag === "--readiness") {
			if (!READINESS.has(value)) return { ok: false, error: "--readiness must be check or watch." };
			if (value === "check" || value === "watch") args.readiness = value;
		} else return { ok: false, error: `Unknown option: ${flag}.` };
	}
	return { ok: true, args };
}
