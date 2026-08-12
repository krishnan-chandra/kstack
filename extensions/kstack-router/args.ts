/** Pure argument parser for the /kstack command. */

import { DEFAULTS, isChangeKind, isRouteId, type ChangeKind, type DeliveryRecommendation, type RouterArgs } from "./types.ts";

export type ArgsParse =
	| { ok: true; args: RouterArgs }
	| { ok: false; error: string };

/**
 * Parse /kstack leading options. Supports:
 *   /kstack --route investigate Refactor the widget
 *   /kstack --single Refactor the widget
 *   /kstack --route change --stack Implement CI pipeline
 *   /kstack --route change --change-kind feature "Add feature X"
 *   /kstack --route change --single -- "Add feature X"
 *   /kstack investigate (flag-less task with no leading --)
 *
 * Uses `--` to terminate flag parsing so tasks starting with dashes work.
 */
export function parseArgs(input: string): ArgsParse {
	const trimmed = input.trim();
	if (!trimmed) return { ok: true, args: { task: "" } };

	const tokens = tokenize(trimmed);
	if (typeof tokens === "string") return { ok: false, error: tokens };

	let route: string | undefined;
	let delivery: DeliveryRecommendation;
	let changeKind: ChangeKind | undefined;
	let postDash = false;
	let i = 0;

	// Parse leading flags until we hit a non-flag or `--`.
	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") {
			postDash = true;
			i++;
			break;
		}
		if (!token.startsWith("--")) break;

		if (token === "--route") {
			if (route !== undefined) return { ok: false, error: "Duplicate --route flag." };
			i++;
			route = tokens[i];
			if (!route || route.startsWith("--")) {
				return { ok: false, error: "--route requires a value (e.g. --route investigate)." };
			}
			continue;
		}

		if (token === "--single" || token === "--stack") {
			if (delivery) return { ok: false, error: "Specify at most one of --single or --stack." };
			delivery = token === "--stack" ? "stack" : "single";
			continue;
		}

		if (token === "--change-kind") {
			if (changeKind !== undefined) return { ok: false, error: "Duplicate --change-kind flag." };
			i++;
			const value = tokens[i];
			if (!value || value.startsWith("--") || !isChangeKind(value)) {
				return { ok: false, error: "--change-kind requires one of: bug-fix, feature, refactor, performance, prototype, generic." };
			}
			changeKind = value;
			continue;
		}

		return { ok: false, error: `Unknown flag: ${token}. Supported: --route <id>, --single, --stack, --change-kind <kind>.` };
	}

	// Validate route if provided.
	if (route !== undefined && !isRouteId(route)) {
		return {
			ok: false,
			error: `Unknown route "${route}". Valid routes: investigate, change, arena, swarm, skill-authoring, session-pickup, review.`,
		};
	}

	// Remaining tokens form the task.
	const taskTokens = tokens.slice(i);
	const task = postDash ? taskTokens.join(" ") : taskTokens.join(" ");

	const taskBytes = Buffer.byteLength(task, "utf8");
	if (taskBytes > DEFAULTS.maxTaskBytes) {
		return {
			ok: false,
			error: `Task is ${taskBytes} bytes; the limit is ${DEFAULTS.maxTaskBytes} bytes.`,
		};
	}

	return {
		ok: true,
		args: {
			route: route ? (route as RouterArgs["route"]) : undefined,
			delivery,
			changeKind,
			task: task.trim(),
		},
	};
}

/**
 * Simple tokenizer that splits on whitespace but preserves quoted strings.
 * Returns the token array or an error string on unterminated quotes.
 */
function tokenize(input: string): string[] | string {
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
	if (quote) return `Unterminated ${quote} quote in arguments.`;
	if (hasCurrent || current.length > 0) tokens.push(current);
	return tokens;
}