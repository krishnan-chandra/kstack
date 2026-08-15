/** `/jj-stack` argument parser. */

import { DEFAULT_MAX_STACK, MAX_NAME_CHARS, MAX_REVSET_CHARS, MIN_MAX_STACK } from "./types.ts";

type JjStackCommand =
	| { action: "inspect"; top?: string; trunk: string; maxStack: number }
	| { action: "plan"; top: string; remote: string; trunk: string; maxStack: number }
	| { action: "publish"; top: string; remote: string; trunk: string; maxStack: number }
	| { action: "sync"; top: string; remote: string; trunk: string; maxStack: number }
	| { action: "advance"; merged: string; top: string; remote: string; trunk: string; maxStack: number };

const ACTIONS = new Set(["inspect", "plan", "publish", "sync", "advance"]);

export function parseJjStackArgs(text: string): { ok: true; command: JjStackCommand } | { ok: false; error: string } {
	const tokens = text.trim() ? text.trim().split(/\s+/) : [];
	if (tokens.length === 0) return { ok: false, error: "Usage: /jj-stack inspect|plan|publish|sync|advance [options]" };
	const action = tokens[0];
	if (!ACTIONS.has(action)) return { ok: false, error: `Unknown /jj-stack action: ${action}.` };

	const flags = new Map<string, string>();
	for (let i = 1; i < tokens.length; i++) {
		const flag = tokens[i];
		if (!flag.startsWith("--")) return { ok: false, error: `Unexpected argument: ${flag}.` };
		if (flags.has(flag)) return { ok: false, error: `Duplicate option: ${flag}.` };
		const value = tokens[++i];
		if (!value || value.startsWith("--")) return { ok: false, error: `Missing value for ${flag}.` };
		flags.set(flag, value);
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
	const remote = flags.get("--remote");
	const merged = flags.get("--merged");
	for (const [flag] of flags) {
		if (!["--top", "--remote", "--trunk", "--max-stack", "--merged"].includes(flag)) {
			return { ok: false, error: `Unknown option: ${flag}.` };
		}
	}
	if (trunk.length === 0 || trunk.length > MAX_REVSET_CHARS) return { ok: false, error: "Invalid --trunk revset." };
	if (top !== undefined && !validName(top)) return { ok: false, error: "Invalid --top bookmark." };
	if (remote !== undefined && !validName(remote)) return { ok: false, error: "Invalid --remote name." };
	if (merged !== undefined && !validName(merged)) return { ok: false, error: "Invalid --merged bookmark." };

	if (action === "inspect") {
		if (remote !== undefined || merged !== undefined) {
			return { ok: false, error: "inspect accepts only --top, --trunk, and --max-stack." };
		}
		return { ok: true, command: { action: "inspect", top, trunk, maxStack } };
	}
	if (action === "advance") {
		if (!merged || !top || !remote) {
			return { ok: false, error: "advance requires --merged, --top, and --remote." };
		}
		return { ok: true, command: { action: "advance", merged, top, remote, trunk, maxStack } };
	}
	if (action !== "plan" && action !== "publish" && action !== "sync") {
		return { ok: false, error: `Unknown /jj-stack action: ${action}.` };
	}
	if (!top || !remote) return { ok: false, error: `${action} requires --top and --remote.` };
	if (merged !== undefined) return { ok: false, error: `${action} does not accept --merged.` };
	return { ok: true, command: { action, top, remote, trunk, maxStack } };
}

export function completeJjStackArgs(prefix: string): Array<{ value: string; label: string }> {
	const tokens = prefix.trim() ? prefix.trim().split(/\s+/) : [];
	const last = prefix.endsWith(" ") ? "" : (tokens.at(-1) ?? "");
	if (tokens.length === 0 || (tokens.length === 1 && !prefix.endsWith(" ") && !ACTIONS.has(tokens[0]))) {
		return [...ACTIONS].filter((value) => value.startsWith(last)).map((value) => ({ value, label: value }));
	}
	const action = tokens[0];
	const options =
		action === "inspect"
			? ["--top ", "--trunk ", "--max-stack "]
			: action === "advance"
				? ["--merged ", "--top ", "--remote ", "--trunk ", "--max-stack "]
				: ["--top ", "--remote ", "--trunk ", "--max-stack "];
	return options
		.filter((value) => value.startsWith(last))
		.map((value) => ({ value: value.trim(), label: value.trim() }));
}

function validName(value: string): boolean {
	return value.length > 0 && value.length <= MAX_NAME_CHARS && !/[\0\n\r\s]/.test(value);
}
