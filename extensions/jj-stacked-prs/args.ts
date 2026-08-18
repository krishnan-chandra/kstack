/** `/jj-stack` argument parser. */

import { isMergeMethod } from "../shared/github.ts";
import {
	DEFAULT_MAX_STACK,
	MAX_NAME_CHARS,
	MAX_REVSET_CHARS,
	MIN_MAX_STACK,
	type StackMergeMethod,
	type StackReadinessMode,
} from "./types.ts";

type JjStackCommand =
	| { action: "inspect"; top?: string; trunk: string; maxStack: number }
	| { action: "plan"; top: string; remote: string; trunk: string; maxStack: number }
	| { action: "publish"; top: string; remote: string; trunk: string; maxStack: number; ready: boolean }
	| { action: "sync"; top: string; remote: string; trunk: string; maxStack: number }
	| { action: "advance"; merged: string; top: string; remote: string; trunk: string; maxStack: number }
	| {
			action: "land";
			top: string;
			remote: string;
			trunk: string;
			maxStack: number;
			method?: StackMergeMethod;
			readiness: StackReadinessMode;
	  };

const ACTIONS = new Set(["inspect", "plan", "publish", "sync", "advance", "land"]);
const BOOLEAN_FLAGS = new Set(["--ready"]);
const READINESS_MODES: ReadonlySet<string> = new Set(["check", "watch"]);

export function parseJjStackArgs(text: string): { ok: true; command: JjStackCommand } | { ok: false; error: string } {
	const tokens = text.trim() ? text.trim().split(/\s+/) : [];
	if (tokens.length === 0) {
		return { ok: false, error: "Usage: /jj-stack inspect|plan|publish|sync|advance|land [options]" };
	}
	const action = tokens[0];
	if (!ACTIONS.has(action)) return { ok: false, error: `Unknown /jj-stack action: ${action}.` };

	const flags = new Map<string, string>();
	for (let i = 1; i < tokens.length; i++) {
		const flag = tokens[i];
		if (!flag.startsWith("--")) return { ok: false, error: `Unexpected argument: ${flag}.` };
		if (flags.has(flag)) return { ok: false, error: `Duplicate option: ${flag}.` };
		if (BOOLEAN_FLAGS.has(flag)) {
			flags.set(flag, "true");
			continue;
		}
		const value = tokens[++i];
		if (!value || value.startsWith("--")) return { ok: false, error: `Missing value for ${flag}.` };
		flags.set(flag, value);
	}

	const allowed = allowedFlags(action);
	for (const flag of flags.keys()) {
		if (!allowed.has(flag)) return { ok: false, error: `Unknown option: ${flag}.` };
	}

	const trunk = flags.get("--trunk") ?? "trunk()";
	const maxStackRaw = flags.get("--max-stack");
	let maxStack = DEFAULT_MAX_STACK;
	if (maxStackRaw !== undefined) {
		const parsed = Number(maxStackRaw);
		if (!Number.isSafeInteger(parsed) || parsed < MIN_MAX_STACK || parsed > DEFAULT_MAX_STACK) {
			return { ok: false, error: `--max-stack must be an integer from ${MIN_MAX_STACK} to ${DEFAULT_MAX_STACK}.` };
		}
		maxStack = parsed;
	}
	const top = flags.get("--top");
	const remote = flags.get("--remote") ?? "origin";
	const merged = flags.get("--merged");
	if (trunk.length === 0 || trunk.length > MAX_REVSET_CHARS) return { ok: false, error: "Invalid --trunk revset." };
	if (top !== undefined && !validName(top)) return { ok: false, error: "Invalid --top bookmark." };
	if (!validName(remote)) return { ok: false, error: "Invalid --remote name." };
	if (merged !== undefined && !validName(merged)) return { ok: false, error: "Invalid --merged bookmark." };

	if (action === "inspect") {
		return { ok: true, command: { action: "inspect", top, trunk, maxStack } };
	}
	if (action === "advance") {
		if (!merged || !top) {
			return { ok: false, error: "advance requires --merged and --top." };
		}
		return { ok: true, command: { action: "advance", merged, top, remote, trunk, maxStack } };
	}
	if (action === "land") {
		if (!top) return { ok: false, error: "land requires --top." };
		const methodRaw = flags.get("--method");
		if (methodRaw !== undefined && !isMergeMethod(methodRaw)) {
			return { ok: false, error: "--method must be squash or rebase." };
		}
		const readinessRaw = flags.get("--readiness") ?? "watch";
		if (!isReadiness(readinessRaw)) {
			return { ok: false, error: "--readiness must be check or watch." };
		}
		return {
			ok: true,
			command: {
				action: "land",
				top,
				remote,
				trunk,
				maxStack,
				method: methodRaw,
				readiness: readinessRaw,
			},
		};
	}
	if (action !== "plan" && action !== "publish" && action !== "sync") {
		return { ok: false, error: `Unknown /jj-stack action: ${action}.` };
	}
	if (!top) return { ok: false, error: `${action} requires --top.` };
	if (action === "publish") {
		return { ok: true, command: { action: "publish", top, remote, trunk, maxStack, ready: flags.has("--ready") } };
	}
	return { ok: true, command: { action, top, remote, trunk, maxStack } };
}

const METHOD_VALUES = ["squash", "rebase"] as const;
const READINESS_VALUES = ["check", "watch"] as const;

/**
 * Complete `/jj-stack` actions, flags, and the finite `--method` /
 * `--readiness` values. Bookmark, remote, trunk, and max-stack values stay
 * free-form. Earlier tokens stay in the replacement `value` because Pi
 * replaces the whole argument prefix.
 */
export function completeJjStackArgs(prefix: string): Array<{ value: string; label: string }> | null {
	let tokenStart = prefix.length;
	while (tokenStart > 0) {
		const character = prefix[tokenStart - 1];
		if (character === undefined || /\s/.test(character)) break;
		tokenStart--;
	}
	const base = prefix.slice(0, tokenStart);
	const token = prefix.slice(tokenStart);
	const priorTokens = base.trim().length > 0 ? base.trim().split(/\s+/) : [];

	if (priorTokens.length === 0) {
		const items = [...ACTIONS]
			.filter((value) => value.startsWith(token))
			.map((value) => ({
				value: `${base}${value}`,
				label: value,
			}));
		return items.length > 0 ? items : null;
	}

	const action = priorTokens[0];
	if (!ACTIONS.has(action)) return null;

	const previousToken = priorTokens.at(-1);
	if (previousToken === "--method") {
		const items = METHOD_VALUES.filter((value) => value.startsWith(token)).map((value) => ({
			value: `${base}${value}`,
			label: value,
		}));
		return items.length > 0 ? items : null;
	}
	if (previousToken === "--readiness") {
		const items = READINESS_VALUES.filter((value) => value.startsWith(token)).map((value) => ({
			value: `${base}${value}`,
			label: value,
		}));
		return items.length > 0 ? items : null;
	}
	if (previousToken?.startsWith("--") && !BOOLEAN_FLAGS.has(previousToken)) {
		return null;
	}

	if (token !== "" && !token.startsWith("--")) return null;
	const items = completionFlags(action)
		.filter((flag) => flag.startsWith(token))
		.map((flag) => ({ value: `${base}${flag}`, label: flag }));
	return items.length > 0 ? items : null;
}

function allowedFlags(action: string): Set<string> {
	if (action === "inspect") return new Set(["--top", "--trunk", "--max-stack"]);
	if (action === "advance") return new Set(["--merged", "--top", "--remote", "--trunk", "--max-stack"]);
	if (action === "land") return new Set(["--top", "--remote", "--trunk", "--max-stack", "--method", "--readiness"]);
	if (action === "publish") return new Set(["--top", "--remote", "--trunk", "--max-stack", "--ready"]);
	return new Set(["--top", "--remote", "--trunk", "--max-stack"]);
}

function completionFlags(action: string): string[] {
	if (action === "inspect") return ["--top", "--trunk", "--max-stack"];
	if (action === "advance") return ["--merged", "--top", "--remote", "--trunk", "--max-stack"];
	if (action === "land") return ["--top", "--remote", "--trunk", "--method", "--readiness", "--max-stack"];
	if (action === "publish") return ["--top", "--remote", "--trunk", "--max-stack", "--ready"];
	return ["--top", "--remote", "--trunk", "--max-stack"];
}

function isReadiness(value: string): value is StackReadinessMode {
	return READINESS_MODES.has(value);
}

function validName(value: string): boolean {
	return value.length > 0 && value.length <= MAX_NAME_CHARS && !/[\0\n\r\s]/.test(value);
}
