/** Pure task validation, delivery-mode parsing, and panel-review options. */

import type { PanelArgs } from "../panel-review/types.ts";
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

function boundedPanelIntent(task: string): string {
	const oneLine = task.replace(/\s+/g, " ").trim();
	return Array.from(oneLine).slice(0, LIMITS.panelIntentChars).join("");
}

export function buildPanelReviewOptions(task: string): PanelArgs {
	return { intent: `Plan/implement: ${boundedPanelIntent(task)}` };
}

/** Review a completed local stack against the immutable trunk SHA from preflight. */
export function buildStackPanelReviewOptions(task: string, trunkSha: string): PanelArgs {
	return {
		base: trunkSha,
		intent: `Plan/implement (stacked): ${boundedPanelIntent(task)}`,
	};
}
