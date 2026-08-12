/** Pure task validation and panel-review request formatting. */

import { LIMITS } from "./types.ts";

export function validateTask(task: string): { ok: true; task: string } | { ok: false; error: string } {
	const trimmed = task.trim();
	if (!trimmed) return { ok: false, error: "plan-implement requires a non-empty task." };
	const bytes = Buffer.byteLength(trimmed, "utf8");
	if (bytes > LIMITS.taskBytes) {
		return { ok: false, error: `Task is ${bytes} bytes; the limit is ${LIMITS.taskBytes} bytes.` };
	}
	return { ok: true, task: trimmed };
}

export function buildPanelReviewArgs(task: string): string {
	// panel-review's tokenizer treats backslash-before-quote specially, so
	// normalize backslashes before placing user text in one quoted argument.
	const oneLine = task.replace(/\\/g, "∖").replace(/\s+/g, " ").trim();
	const bounded = Array.from(oneLine).slice(0, LIMITS.panelIntentChars).join("");
	const escaped = bounded.replace(/"/g, '\\"');
	return `--intent "Plan/implement: ${escaped}"`;
}
