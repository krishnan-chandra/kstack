/**
 * Strict parser for `/panel-review` command arguments.
 *
 * Supported:
 *   /panel-review
 *   /panel-review --base main
 *   /panel-review --intent "Add safe bulk session archival"
 *   /panel-review --base origin/main --intent "Implement handoff"
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
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		let flag = token;
		let value: string | undefined;
		const eq = token.indexOf("=");
		if (token.startsWith("--") && eq !== -1) {
			flag = token.slice(0, eq);
			value = token.slice(eq + 1);
		}
		switch (flag) {
			case "--base":
			case "--intent": {
				if (value === undefined) {
					value = tokens[++i];
					if (value === undefined) return { ok: false, error: `${flag} requires a value.` };
				}
				if (value.length === 0) return { ok: false, error: `${flag} requires a non-empty value.` };
				if (flag === "--base") args.base = value;
				else args.intent = value;
				break;
			}
			default:
				return {
					ok: false,
					error: `Unknown argument "${token}". Usage: /panel-review [--base <ref>] [--intent <text>]`,
				};
		}
	}
	return { ok: true, args };
}
