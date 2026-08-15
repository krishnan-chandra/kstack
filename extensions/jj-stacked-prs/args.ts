/** `/jj-stack` argument parser. */

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
const MERGE_METHODS: ReadonlySet<string> = new Set(["squash", "rebase"]);
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
	const remote = flags.get("--remote");
	const merged = flags.get("--merged");
	if (trunk.length === 0 || trunk.length > MAX_REVSET_CHARS) return { ok: false, error: "Invalid --trunk revset." };
	if (top !== undefined && !validName(top)) return { ok: false, error: "Invalid --top bookmark." };
	if (remote !== undefined && !validName(remote)) return { ok: false, error: "Invalid --remote name." };
	if (merged !== undefined && !validName(merged)) return { ok: false, error: "Invalid --merged bookmark." };

	if (action === "inspect") {
		return { ok: true, command: { action: "inspect", top, trunk, maxStack } };
	}
	if (action === "advance") {
		if (!merged || !top || !remote) {
			return { ok: false, error: "advance requires --merged, --top, and --remote." };
		}
		return { ok: true, command: { action: "advance", merged, top, remote, trunk, maxStack } };
	}
	if (action === "land") {
		if (!top || !remote) return { ok: false, error: "land requires --top and --remote." };
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
	if (!top || !remote) return { ok: false, error: `${action} requires --top and --remote.` };
	if (action === "publish") {
		return { ok: true, command: { action: "publish", top, remote, trunk, maxStack, ready: flags.has("--ready") } };
	}
	return { ok: true, command: { action, top, remote, trunk, maxStack } };
}

export function completeJjStackArgs(prefix: string): Array<{ value: string; label: string }> {
	const tokens = prefix.trim() ? prefix.trim().split(/\s+/) : [];
	const last = prefix.endsWith(" ") ? "" : (tokens.at(-1) ?? "");
	if (tokens.length === 0 || (tokens.length === 1 && !prefix.endsWith(" ") && !ACTIONS.has(tokens[0]))) {
		return [...ACTIONS].filter((value) => value.startsWith(last)).map((value) => ({ value, label: value }));
	}
	const action = tokens[0];
	return completionFlags(action)
		.filter((value) => value.startsWith(last))
		.map((value) => ({ value: value.trim(), label: value.trim() }));
}

function allowedFlags(action: string): Set<string> {
	if (action === "inspect") return new Set(["--top", "--trunk", "--max-stack"]);
	if (action === "advance") return new Set(["--merged", "--top", "--remote", "--trunk", "--max-stack"]);
	if (action === "land") return new Set(["--top", "--remote", "--trunk", "--max-stack", "--method", "--readiness"]);
	if (action === "publish") return new Set(["--top", "--remote", "--trunk", "--max-stack", "--ready"]);
	return new Set(["--top", "--remote", "--trunk", "--max-stack"]);
}

function completionFlags(action: string): string[] {
	if (action === "inspect") return ["--top ", "--trunk ", "--max-stack "];
	if (action === "advance") return ["--merged ", "--top ", "--remote ", "--trunk ", "--max-stack "];
	if (action === "land") return ["--top ", "--remote ", "--trunk ", "--method ", "--readiness ", "--max-stack "];
	if (action === "publish") return ["--top ", "--remote ", "--trunk ", "--max-stack ", "--ready"];
	return ["--top ", "--remote ", "--trunk ", "--max-stack "];
}

function isMergeMethod(value: string): value is StackMergeMethod {
	return MERGE_METHODS.has(value);
}

function isReadiness(value: string): value is StackReadinessMode {
	return READINESS_MODES.has(value);
}

function validName(value: string): boolean {
	return value.length > 0 && value.length <= MAX_NAME_CHARS && !/[\0\n\r\s]/.test(value);
}
