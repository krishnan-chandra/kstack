/**
 * Strict parser for `/panel-review` command arguments.
 *
 * Supported:
 *   /panel-review
 *   /panel-review Add safe bulk session archival
 *   /panel-review --base main Implement handoff
 *   /panel-review --base origin/main "Implement handoff"
 *   /panel-review --pr 42
 *   /panel-review --pr 42 "Review the auth refactor"
 *
 * Everything after the known flags is collected as the free-form intent.
 * When no positional intent is provided, the caller opens an editor for one.
 */

import type { PanelArgs } from "./types.ts";

export type ArgsParse = { ok: true; args: PanelArgs } | { ok: false; error: string };

const PANEL_REVIEW_ARGUMENT_FLAGS = ["--base", "--base=", "--pr", "--pr="] as const;

/**
 * Complete the finite part of `/panel-review` arguments. `parseArgs` only
 * recognizes `--base` and `--pr` while they precede any positional token, so
 * once a non-flag token has appeared the remaining text is free-form intent
 * and no flag completions are offered. The flag values and the intent itself
 * stay free-form.
 */
export function getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
	let tokenStart = prefix.length;
	while (tokenStart > 0) {
		const character = prefix[tokenStart - 1];
		if (character === undefined || /\s/.test(character)) break;
		tokenStart--;
	}
	const base = prefix.slice(0, tokenStart);
	const token = prefix.slice(tokenStart);
	const priorTokens = base.trim().length > 0 ? base.trim().split(/\s+/) : [];
	const previousToken = priorTokens.at(-1);

	// The flag values are free-form; don't offer flags while the cursor is
	// waiting for that value or while it is being entered.
	if (
		previousToken === "--base" ||
		token.startsWith("--base=") ||
		previousToken === "--pr" ||
		token.startsWith("--pr=")
	) {
		return null;
	}

	// Flags are only recognized before the positional intent begins. Once any
	// prior token isn't a flag, the intent has started and stays free-form.
	if (priorTokens.some((prior) => !prior.startsWith("--"))) return null;

	const items = PANEL_REVIEW_ARGUMENT_FLAGS.filter((flag) => flag.startsWith(token)).map((value) => ({
		value: `${base}${value}`,
		label: value,
	}));
	return items.length > 0 ? items : null;
}

/** Split a command argument string into tokens, honoring single/double quotes. */
export function tokenize(input: string): string[] | { error: string } {
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

	let base: string | undefined;
	let pr: number | undefined;
	let i = 0;

	// Parse known flags; unknown flags are rejected before positional intent.
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token.startsWith("--")) break; // positional intent starts here

		let flag = token;
		let value: string | undefined;
		const eq = token.indexOf("=");
		if (eq !== -1) {
			flag = token.slice(0, eq);
			value = token.slice(eq + 1);
		}

		if (flag === "--base") {
			if (value === undefined) {
				value = tokens[++i];
				if (value === undefined) return { ok: false, error: `${flag} requires a value.` };
			}
			if (value.length === 0) return { ok: false, error: `${flag} requires a non-empty value.` };
			base = value;
			i++;
		} else if (flag === "--pr") {
			if (value === undefined) {
				value = tokens[++i];
				if (value === undefined) return { ok: false, error: `${flag} requires a value.` };
			}
			if (value.length === 0) return { ok: false, error: `${flag} requires a non-empty value.` };
			const prNumber = Number(value);
			// Keep the digit check so decimal and exponent spellings such as 42.0
			// and 4e2 are rejected even when Number() produces an integer.
			if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !/^\d+$/.test(value)) {
				return { ok: false, error: `${flag} requires a positive integer PR number.` };
			}
			pr = prNumber;
			i++;
		} else {
			return {
				ok: false,
				error: `Unknown argument "${token}". Usage: /panel-review [--base <ref> | --pr <number>] <intent>`,
			};
		}
	}

	if (base !== undefined && pr !== undefined) {
		return { ok: false, error: "--pr and --base are mutually exclusive." };
	}

	const intent = i < tokens.length ? tokens.slice(i).join(" ") : undefined;
	if (pr !== undefined) return { ok: true, args: { pr, ...(intent !== undefined ? { intent } : undefined) } };
	return {
		ok: true,
		args: {
			...(base !== undefined ? { base } : undefined),
			...(intent !== undefined ? { intent } : undefined),
		},
	};
}
