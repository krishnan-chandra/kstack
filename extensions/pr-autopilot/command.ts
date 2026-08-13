/** Argument parser for the /pr-autopilot command. */

import type { AutopilotMode } from "./types.ts";

export type ArgsParse = { ok: true; args: ParsedArgs } | { ok: false; error: string };

export interface ParsedArgs {
	mode: AutopilotMode;
	/** Explicit PR number, or undefined to auto-detect the lowest unmerged. */
	pr?: number;
}

const MODES: ReadonlySet<string> = new Set(["check", "threads", "drive", "watch", "cleanup"]);

/** Split a command argument string into tokens, honoring single/double quotes. */
function tokenize(input: string): string[] | { error: string } {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let hasCurrent = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (ch === "\\" && quote === '"' && i + 1 < input.length && input[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasCurrent = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (hasCurrent || current.length > 0) {
				tokens.push(current);
				current = "";
				hasCurrent = false;
			}
			continue;
		}
		current += ch;
	}
	if (quote) return { error: `Unterminated ${quote} quote in arguments.` };
	if (hasCurrent || current.length > 0) tokens.push(current);
	return tokens;
}

export function parseArgs(input: string): ArgsParse {
	const tokens = tokenize(input);
	if (!Array.isArray(tokens)) return { ok: false, error: tokens.error };

	const parsed: ParsedArgs = { mode: "check" };
	let modeSeen = false;
	let prSeen = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const eq = token.indexOf("=");
		const hasEq = token.startsWith("--") && eq !== -1;
		const flag = hasEq ? token.slice(0, eq) : token;
		const inlineValue = hasEq ? token.slice(eq + 1) : undefined;

		if (flag === "--mode") {
			if (modeSeen) return { ok: false, error: "Duplicate --mode flag." };
			modeSeen = true;
			const value = inlineValue ?? tokens[++i];
			if (!value) return { ok: false, error: "--mode requires a value (check, threads, drive, watch, cleanup)." };
			if (!MODES.has(value)) {
				return { ok: false, error: `--mode must be one of: check, threads, drive, watch, cleanup (got "${value}").` };
			}
			parsed.mode = value as AutopilotMode;
			continue;
		}

		if (flag === "--pr") {
			if (prSeen) return { ok: false, error: "Duplicate --pr flag." };
			prSeen = true;
			const value = inlineValue ?? tokens[++i];
			if (!value) return { ok: false, error: "--pr requires a value." };
			const num = Number(value);
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(num) || num < 1) {
				return { ok: false, error: `--pr must be a positive integer (got "${value}").` };
			}
			parsed.pr = num;
			continue;
		}


		// Bare --mode=check shorthand is handled above via hasEq.
		if (hasEq) {
			return { ok: false, error: `Unknown flag "${flag}". Supported: --mode, --pr.` };
		}

		if (token.startsWith("--")) {
			return { ok: false, error: `Unknown flag "${token}". Supported: --mode, --pr.` };
		}

		return { ok: false, error: `Unexpected argument "${token}". Supported: --mode, --pr.` };
	}
	return { ok: true, args: parsed };
}
