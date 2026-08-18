import { isMergeMethod } from "../shared/github.ts";
import type { MergeMethod, ReadinessMode } from "./types.ts";

interface LandArgs {
	pr?: number;
	method?: MergeMethod;
	readiness: ReadinessMode;
}
const READINESS: ReadonlySet<string> = new Set(["check", "watch"]);
const LAND_FLAGS = ["--pr", "--method", "--readiness"] as const;
const LAND_METHODS = ["squash", "rebase"] as const;
const LAND_READINESS = ["check", "watch"] as const;
const LAND_KNOWN_FLAGS = new Set<string>(LAND_FLAGS);

/**
 * Complete `/land` flags and the finite `--method` / `--readiness` values.
 * `--pr` is offered as a flag only; its number is never guessed. Earlier
 * flags stay in the replacement `value` because Pi replaces the whole
 * argument prefix.
 */
export function completeLandArgs(prefix: string): Array<{ value: string; label: string }> | null {
	let tokenStart = prefix.length;
	while (tokenStart > 0) {
		const character = prefix[tokenStart - 1];
		if (character === undefined || /\s/.test(character)) break;
		tokenStart--;
	}
	const base = prefix.slice(0, tokenStart);
	const token = prefix.slice(tokenStart);
	const priorTokens = base.trim().length > 0 ? base.trim().split(/\s+/) : [];

	for (let i = 0; i < priorTokens.length; i++) {
		const prior = priorTokens[i];
		if (!LAND_KNOWN_FLAGS.has(prior)) return null;
		const value = priorTokens[i + 1];
		if (value !== undefined && !value.startsWith("--")) i++;
	}

	const previousToken = priorTokens.at(-1);
	if (previousToken === "--pr") return null;
	if (previousToken === "--method") {
		const items = LAND_METHODS.filter((value) => value.startsWith(token)).map((value) => ({
			value: `${base}${value}`,
			label: value,
		}));
		return items.length > 0 ? items : null;
	}
	if (previousToken === "--readiness") {
		const items = LAND_READINESS.filter((value) => value.startsWith(token)).map((value) => ({
			value: `${base}${value}`,
			label: value,
		}));
		return items.length > 0 ? items : null;
	}

	if (token !== "" && !token.startsWith("--")) return null;
	const items = LAND_FLAGS.filter((flag) => flag.startsWith(token)).map((flag) => ({
		value: `${base}${flag}`,
		label: flag,
	}));
	return items.length > 0 ? items : null;
}

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
			if (!isMergeMethod(value))
				return { ok: false, error: "--method must be squash or rebase; merge commits are not supported by kstack." };
			args.method = value;
		} else if (flag === "--readiness") {
			if (!READINESS.has(value)) return { ok: false, error: "--readiness must be check or watch." };
			if (value === "check" || value === "watch") args.readiness = value;
		} else return { ok: false, error: `Unknown option: ${flag}.` };
	}
	return { ok: true, args };
}
