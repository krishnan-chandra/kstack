/**
 * Handoff extension — continue in a lean session that references the previous
 * session instead of copying or summarizing its conversation history.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff                        # continue from the prior resume point
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildReferenceHandoffPrompt,
	DEFAULT_HANDOFF_GOAL,
	formatHistoryReference,
} from "./handoff-context.ts";
import {
	findHandoffSource,
	readHandoffHistory,
	searchHandoffHistory,
	type HandoffSource,
} from "./history-reader.ts";

/** Build the command handler separately so lifecycle behavior is easy to test. */
export function createHandoffHandler() {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("handoff requires interactive mode", "error");
			return;
		}

		const goal = args.trim() || DEFAULT_HANDOFF_GOAL;
		await ctx.waitForIdle();

		// Reference-only handoff requires a durable source artifact. An ephemeral
		// session cannot be recovered after replacement, so fail before editing or
		// creating anything.
		const oldFile = ctx.sessionManager.getSessionFile();
		if (oldFile === undefined) {
			ctx.ui.notify("handoff requires a persisted session and is unavailable with --no-session", "error");
			return;
		}

		// Capture only plain strings before replacement. The old command context
		// becomes stale after newSession succeeds.
		const oldId = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd;
		const historyRef = formatHistoryReference(oldFile, oldId, cwd);
		const source: HandoffSource = { version: 1, sessionFile: oldFile, sessionId: oldId, cwd };
		const draft = buildReferenceHandoffPrompt(goal, historyRef);

		const edited = await ctx.ui.editor("Edit handoff prompt", draft);
		if (edited === undefined) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (edited.trim() === "") {
			ctx.ui.notify("Handoff prompt cannot be empty", "error");
			return;
		}

		const result = await ctx.newSession({
			parentSession: oldFile,
			setup: async (sm) => {
				sm.appendCustomMessageEntry("handoff", historyRef, true, source);
			},
			withSession: async (fresh) => {
				fresh.ui.setEditorText(edited);
				fresh.ui.notify(`Handoff ready. Previous session: ${oldFile}`, "info");
			},
		});

		if (result.cancelled) {
			ctx.ui.notify("New session cancelled", "info");
		}
	};
}

function requireHandoffSource(ctx: { sessionManager: { getBranch(): unknown[] } }): HandoffSource {
	const source = findHandoffSource(ctx.sessionManager.getBranch() as never[]);
	if (!source) {
		throw new Error("No handoff history is linked to this session. Run /handoff from a persisted session first.");
	}
	return source;
}

export default async function (pi: ExtensionAPI) {
	const [{ Type }, { StringEnum }] = await Promise.all([import("typebox"), import("@earendil-works/pi-ai")]);

	pi.registerCommand("handoff", {
		description: "Continue in a lean session linked to the current session's history",
		handler: createHandoffHandler(),
	});

	pi.registerTool({
		name: "read_handoff_history",
		label: "Read Handoff History",
		description:
			"Read normalized entries from the previous session linked by /handoff. Resolves the active JSONL first " +
			"and transparently falls back to the read-only archive by exact session ID. Defaults to the latest 50 " +
			"entries. Output is paginated and chunked. Read-only; accepts no filesystem path.",
		promptSnippet: "Read relevant entries from the previous session linked by /handoff",
		promptGuidelines: [
			"Use read_handoff_history before continuing work in a session created by /handoff; inspect the prior decisions and resume point without rereading unrelated history.",
		],
		parameters: Type.Object({
			offset: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 2_147_483_647, description: "Entry offset; overrides from" }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Entries per page (default 50)" })),
			chunk: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Chunk within this page (default 0)" }),
			),
			from: Type.Optional(
				StringEnum(["start", "tail"] as const, {
					description: "Read from the start or latest entries (default tail); ignored when offset is provided",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const source = requireHandoffSource(ctx);
			const text = readHandoffHistory(source, params);
			return { content: [{ type: "text" as const, text }], details: { sessionId: source.sessionId } };
		},
	});

	pi.registerTool({
		name: "search_handoff_history",
		label: "Search Handoff History",
		description:
			"Search normalized text only within the previous session linked by /handoff. Searches the active JSONL " +
			"or transparently falls back to its archived FTS index. Read-only; accepts no filesystem path.",
		promptSnippet: "Search the previous /handoff session for a decision, file, error, or topic",
		promptGuidelines: [
			"Use search_handoff_history for targeted lookup when read_handoff_history would retrieve unrelated prior entries.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Plain words or quoted phrases to find in the previous session" }),
			role: Type.Optional(Type.String({ description: "Only entries with this role, such as user or assistant" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum matches (default 20)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const source = requireHandoffSource(ctx);
			const text = searchHandoffHistory(source, params);
			return { content: [{ type: "text" as const, text }], details: { sessionId: source.sessionId } };
		},
	});
}
