/**
 * Strict parser for `/panel-review` command arguments.
 *
 * Supported:
 *   /panel-review
 *   /panel-review Add safe bulk session archival
 *   /panel-review --base main Implement handoff
 *   /panel-review --base origin/main "Implement handoff"
 *
 * Everything after the known flags is collected as the free-form intent.
 * When no positional intent is provided, the caller opens an editor for one.
 */

import type { PanelArgs } from "./types.ts";

export type ArgsParse = { ok: true; args: PanelArgs } | { ok: false; error: string };

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

	const args: PanelArgs = {};
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
			args.base = value;
			i++;
		} else {
			return {
				ok: false,
				error: `Unknown argument "${token}". Usage: /panel-review [--base <ref>] <intent>`,
			};
		}
	}

	// Remaining tokens are the positional intent.
	if (i < tokens.length) {
		args.intent = tokens.slice(i).join(" ");
	}

	return { ok: true, args };
}
