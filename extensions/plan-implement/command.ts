/** Pure task validation, delivery-mode parsing, and panel-review request formatting. */

import { LIMITS, type DeliveryMode } from "./types.ts";

const DELIVERY_FLAGS = new Set(["--single", "--stack"]);

export function validateTask(task: string): { ok: true; task: string } | { ok: false; error: string } {
	const trimmed = task.trim();
	if (!trimmed) return { ok: false, error: "plan-implement requires a non-empty task." };
	const bytes = Buffer.byteLength(trimmed, "utf8");
	if (bytes > LIMITS.taskBytes) {
		return { ok: false, error: `Task is ${bytes} bytes; the limit is ${LIMITS.taskBytes} bytes.` };
	}
	return { ok: true, task: trimmed };
}

/**
 * Parse a leading `--single` / `--stack` delivery flag from the command args.
 * The flag is optional and may appear at most once, at the front of the string.
 * Everything after the flag (or the whole string when no flag is present) is the
 * task text. Unknown leading `--` flags are rejected so a typo does not silently
 * become the task.
 */
export function parseDeliveryMode(
	args: string,
): { ok: true; mode: DeliveryMode; task: string } | { ok: false; error: string } {
	const trimmed = args.trim();
	if (!trimmed) return { ok: true, mode: "single", task: "" };
	const tokens = trimmed.split(/\s+/);
	if (tokens[0].startsWith("--") && !DELIVERY_FLAGS.has(tokens[0])) {
		return { ok: false, error: `Unknown plan-implement flag: ${tokens[0]}. Use --single or --stack.` };
	}
	if (DELIVERY_FLAGS.has(tokens[0])) {
		const mode: DeliveryMode = tokens[0] === "--stack" ? "stack" : "single";
		const rest = tokens.slice(1).join(" ");
		if (rest.trim() && DELIVERY_FLAGS.has(rest.split(/\s+/)[0])) {
			return { ok: false, error: "Specify at most one of --single or --stack." };
		}
		return { ok: true, mode, task: rest };
	}
	return { ok: true, mode: "single", task: trimmed };
}

export function buildPanelReviewArgs(task: string): string {
	// panel-review's tokenizer treats backslash-before-quote specially, so
	// normalize backslashes before placing user text in one quoted argument.
	const oneLine = task.replace(/\\/g, "∖").replace(/\s+/g, " ").trim();
	const bounded = Array.from(oneLine).slice(0, LIMITS.panelIntentChars).join("");
	const escaped = bounded.replace(/"/g, '\\"');
	return `--intent "Plan/implement: ${escaped}"`;
}

/**
 * Build panel-review args for a stacked-PR run. The base is the immutable
 * trunk() SHA captured before implementation so the whole stack is reviewed
 * once against a stable baseline.
 */
export function buildStackPanelReviewArgs(task: string, trunkSha: string): string {
	const oneLine = task.replace(/\\/g, "∖").replace(/\s+/g, " ").trim();
	const bounded = Array.from(oneLine).slice(0, LIMITS.panelIntentChars).join("");
	const escaped = bounded.replace(/"/g, '\\"');
	const sha = trunkSha.replace(/[^0-9a-f]/g, "");
	return `--base ${sha} --intent "Plan/implement (stacked): ${escaped}"`;
}
