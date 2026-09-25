/** Deterministic prompt and provenance helpers for the handoff extension. */

import { describeHistoryAccess, type HistoryAccess } from "./history-access.ts";

export const DEFAULT_HANDOFF_GOAL = "Continue implementation from the previous session's resume point.";

const INHERIT =
	"Inherit prior decisions and do not redo completed work. Determine what is done, what is pending, and the concrete resume point, then continue with the goal above.";

/**
 * Stable provenance block embedded in the continuation prompt and stored as a
 * `custom_message` in the new session. The file path is point-in-time
 * provenance; the handoff tools resolve the session ID even after
 * session-archive moves the file.
 */
export function formatHistoryReference(
	sessionFile: string,
	sessionId: string,
	cwd: string,
	access: HistoryAccess,
): string {
	const lookup = describeHistoryAccess(access).lookup;
	return [`Previous session: ${sessionFile}`, `Session ID: ${sessionId}  CWD: ${cwd}`, lookup].join("\n");
}

/**
 * Build a small reference-only continuation prompt. It intentionally contains
 * no copied or synthesized conversation content: the replacement agent should
 * inspect only the portions of the previous session that it needs.
 */
export function buildReferenceHandoffPrompt(goal: string, historyReference: string, access: HistoryAccess): string {
	const steps = [...describeHistoryAccess(access).steps, INHERIT].map((step, index) => `${index + 1}. ${step}`);
	return `Continue work from the previous Pi session.

## Goal
${goal}

## Instructions
${steps.join("\n")}

## Previous session
${historyReference}`;
}
