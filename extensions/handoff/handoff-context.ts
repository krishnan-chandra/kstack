/**
 * Deterministic helpers for the handoff extension: the synthesis prompt,
 * conversation serialization, history-reference formatting, and a rough
 * token budget estimate.
 *
 * This module is pure and dependency-injected so it stays testable under
 * plain `node --test` (Pi's runtime packages are not resolvable there).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

/** Pi's canonical conversation converters, injected by index.ts. */
export interface ConversationConverters {
	convertToLlm: typeof convertToLlm;
	serializeConversation: typeof serializeConversation;
}

export const DEFAULT_HANDOFF_GOAL = "Continue implementation from the current resume point.";

export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings) — do not re-derive; inherit.
2. Lists any relevant files that were discussed or modified.
3. Diffs what is done vs. what is pending and names the resume point (exactly what to do next).
4. Clearly states the next task based on the user's goal.
5. Is self-contained — the new thread should be able to proceed without the old conversation, but must be able to locate it.
6. Includes the history reference block from the input verbatim, so the new thread can find the previous session (and can search the session archive by exact session ID if the file was later archived).

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" — just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Done: ...
Pending: ... Resume at: <the next concrete step>

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on the user's goal]

## Previous session
[History reference block, verbatim]`;

/**
 * Serialize the canonical, compaction-aware message list into plain text for
 * the synthesis call. Filtering of unsupported payloads (tool results, images,
 * etc.) is delegated to Pi's converters.
 */
export function buildHandoffConversationText(
	messages: AgentMessage[],
	converters: ConversationConverters,
): string {
	return converters.serializeConversation(converters.convertToLlm(messages));
}

/**
 * Compose the user message sent to the synthesis model: serialized history,
 * the durable history reference, and the user's goal for the new thread.
 */
export function buildHandoffUserMessage(conversationText: string, goal: string, historyReference: string): string {
	return `## Conversation History\n\n${conversationText}\n\n## History Reference\n\n${historyReference}\n\n## User's Goal for New Thread\n\n${goal}`;
}

/**
 * Guarantee that the editable prompt carries the exact provenance block.
 * Models can omit or rewrite requested output, so this requirement must not
 * rely on prompt compliance alone.
 */
export function ensureHistoryReference(prompt: string, historyReference: string): string {
	if (prompt.includes(historyReference)) return prompt;
	return `${prompt.trimEnd()}\n\n## Previous session\n${historyReference}`;
}

/**
 * Stable provenance block embedded in the generated prompt and stored as a
 * `custom_message` in the new session. The file path is point-in-time
 * provenance (session-archive may later move the JSONL); the session ID is
 * the durable identity usable with search_session_archive after archival.
 */
export function formatHistoryReference(sessionFile: string | undefined, sessionId: string, cwd: string): string {
	if (sessionFile === undefined) {
		return [
			"Previous session: (ephemeral — no file; history is in this prompt only)",
			`Session ID: ${sessionId}  CWD: ${cwd}`,
		].join("\n");
	}
	return [
		`Previous session: ${sessionFile}`,
		`Session ID: ${sessionId}  CWD: ${cwd}`,
		"Lookup: use the active path above; if it is later archived, use search_session_archive with the exact session ID",
	].join("\n");
}

/** Rough token estimate (~4 chars/token) used only for the budget guard. */
export function estimateConversationTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
