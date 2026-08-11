/** Deterministic prompt and provenance helpers for the handoff extension. */

export const DEFAULT_HANDOFF_GOAL = "Continue implementation from the previous session's resume point.";

/**
 * Stable provenance block embedded in the continuation prompt and stored as a
 * `custom_message` in the new session. The file path is point-in-time
 * provenance; the session ID remains usable if session-archive moves the file.
 */
export function formatHistoryReference(sessionFile: string, sessionId: string, cwd: string): string {
	return [
		`Previous session: ${sessionFile}`,
		`Session ID: ${sessionId}  CWD: ${cwd}`,
		"Lookup: use the active path above; if it is later archived, use read_session_archive with the exact session ID (or search_session_archive with session_id to search within it)",
	].join("\n");
}

/**
 * Build a small reference-only continuation prompt. It intentionally contains
 * no copied or synthesized conversation content: the replacement agent should
 * inspect only the portions of the previous session that it needs.
 */
export function buildReferenceHandoffPrompt(goal: string, historyReference: string): string {
	return `Continue work from the previous Pi session.

## Goal
${goal}

## Instructions
1. Call read_handoff_history before making changes; it reads the latest normalized entries from the linked previous session and automatically handles active or archived storage.
2. Use search_handoff_history when targeted lookup for a decision, file, error, or topic is more efficient than paging through unrelated entries.
3. Inherit prior decisions and do not redo completed work. Determine what is done, what is pending, and the concrete resume point, then continue with the goal above.

## Previous session
${historyReference}`;
}
