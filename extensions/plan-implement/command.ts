/** Pure task validation, command parsing, and panel-review options. */

import type { PanelArgs } from "../panel-review/types.ts";
import { isChangeKind, type ChangeKind } from "./change-kind.ts";
import { LIMITS, type DeliveryMode, type WorkLocation } from "./types.ts";

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
 * Parse leading delivery and change-kind options. `--` terminates option
 * parsing so tasks may start with dashes. A direct command defaults to single
 * delivery, but leaves changeKind undefined so the adapter can ask the user.
 */
export function parsePlanImplementArgs(
	args: string,
): { ok: true; mode: DeliveryMode; workLocation: WorkLocation; changeKind?: ChangeKind; task: string } | { ok: false; error: string } {
	const trimmed = args.trim();
	if (!trimmed) return { ok: true, mode: "single", workLocation: "current", task: "" };

	const tokens = trimmed.split(/\s+/);
	let mode: DeliveryMode = "single";
	let workLocation: WorkLocation = "current";
	let deliverySeen = false;
	let changeKind: ChangeKind | undefined;
	let i = 0;

	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--") {
			i++;
			break;
		}
		if (!token.startsWith("--")) break;

		if (DELIVERY_FLAGS.has(token)) {
			if (deliverySeen) return { ok: false, error: "Specify at most one of --single or --stack." };
			deliverySeen = true;
			mode = token === "--stack" ? "stack" : "single";
			continue;
		}

		if (token === "--worktree") {
			if (workLocation === "worktree") return { ok: false, error: "Duplicate --worktree flag." };
			workLocation = "worktree";
			continue;
		}

		if (token === "--change-kind") {
			if (changeKind !== undefined) return { ok: false, error: "Duplicate --change-kind flag." };
			const value = tokens[++i];
			if (!value || value.startsWith("--") || !isChangeKind(value)) {
				return {
					ok: false,
					error: "--change-kind requires one of: bug-fix, feature, refactor, performance, prototype, generic.",
				};
			}
			changeKind = value;
			continue;
		}

		return {
			ok: false,
			error: `Unknown plan-implement flag: ${token}. Use --single, --stack, --worktree, or --change-kind <kind>.`,
		};
	}

	if (mode === "stack" && workLocation === "worktree") {
		return { ok: false, error: "--stack and --worktree cannot currently be combined. Use --stack in the jj workspace or --single --worktree." };
	}
	return { ok: true, mode, workLocation, changeKind, task: tokens.slice(i).join(" ") };
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
