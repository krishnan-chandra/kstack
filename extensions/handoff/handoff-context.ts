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
1. Inspect the previous session before making changes; inherit its decisions and do not redo completed work.
2. If the active JSONL path exists, read it incrementally and focus on relevant user, assistant, tool-result, compaction, and branch-summary entries.
3. If it has been archived, use read_session_archive with the exact session ID. Use search_session_archive with session_id when targeted search is more efficient.
4. Determine what is done, what is pending, and the concrete resume point, then continue with the goal above.

## Previous session
${historyReference}`;
}
