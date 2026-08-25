/** Pure argument-completion helper for the /kstack command. */

import { CHANGE_KINDS } from "../shared/change-kind.ts";
import { ALL_ROUTES, type RouteId } from "./types.ts";

interface KstackCompletionItem {
	value: string;
	label: string;
}

/** Route IDs a user may explicitly select; "unsupported" is never a target. */
const ROUTE_IDS: readonly RouteId[] = ALL_ROUTES.filter((route) => route !== "unsupported");

const AUTOPILOT_MODES = ["check", "threads", "drive", "watch", "cleanup"] as const;
const LAND_METHODS = ["squash", "rebase"] as const;
const READINESS_MODES = ["check", "watch"] as const;

/** Flags that take a finite, completable value. */
const VALUE_FLAGS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
	["--route", ROUTE_IDS],
	["--change-kind", CHANGE_KINDS],
	["--mode", AUTOPILOT_MODES],
	["--method", LAND_METHODS],
	["--readiness", READINESS_MODES],
]);

/**
 * Flags offered when starting a new token. `--pr` takes a value (a PR
 * number) but that value is free-form, so only the flag itself is offered;
 * its value is never guessed.
 */
const ALL_FLAGS = [
	"--route",
	"--single",
	"--stack",
	"--worktree",
	"--change-kind",
	"--mode",
	"--pr",
	"--method",
	"--readiness",
	"--",
] as const;

/**
 * Split `prefix` into the text before the token currently being typed and
 * that token itself. A trailing space means the previous token is complete
 * and a new, empty token is starting.
 */
function splitLastToken(prefix: string) {
	let start = prefix.length;
	while (start > 0) {
		const char = prefix[start - 1];
		if (char === undefined || /\s/.test(char)) break;
		start--;
	}
	return { base: prefix.slice(0, start), token: prefix.slice(start) };
}

const BOOLEAN_FLAGS = new Set(["--single", "--stack", "--worktree"]);
const VALUE_TAKING_FLAGS = new Set([...VALUE_FLAGS.keys(), "--pr"]);

/**
 * `parseArgs` only accepts leading flags. Once `--` or a non-flag token that
 * is not a flag value appears, the rest is task text and must stay free-form.
 */
function leadingFlagsOnly(base: string): boolean {
	const tokens = base.trim().length > 0 ? base.trim().split(/\s+/) : [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") return false;
		if (BOOLEAN_FLAGS.has(token)) continue;
		if (VALUE_TAKING_FLAGS.has(token)) {
			const value = tokens[i + 1];
			if (value !== undefined && !value.startsWith("--")) i++;
			continue;
		}
		return false;
	}
	return true;
}

function toItems(
	base: string,
	values: readonly string[],
	token: string,
	trailingSpace: boolean,
): KstackCompletionItem[] {
	return values
		.filter((value) => value.startsWith(token))
		.map((value) => ({ value: `${base}${value}${trailingSpace ? " " : ""}`, label: value }));
}

/**
 * Complete /kstack arguments. Offers flag names and, immediately after a
 * flag with a finite value set, that flag's valid values. Preserves earlier
 * flags verbatim in the returned `value`. Never completes `--pr`'s numeric
 * value or free-form task text. Returns `null` when there is nothing useful
 * to suggest, including once the task has started.
 */
export function getArgumentCompletions(prefix: string): KstackCompletionItem[] | null {
	const { base, token } = splitLastToken(prefix);

	if (!leadingFlagsOnly(base)) return null;

	const previousToken = base.trimEnd().split(/\s+/).at(-1);

	// --pr takes a free-form PR number; never guess it, and never offer flags
	// while its value is being typed.
	if (previousToken === "--pr") return null;

	const valueSet = previousToken ? VALUE_FLAGS.get(previousToken) : undefined;
	if (valueSet) {
		const items = toItems(base, valueSet, token, true);
		return items.length > 0 ? items : null;
	}

	const items = toItems(base, ALL_FLAGS, token, true);
	return items.length > 0 ? items : null;
}
