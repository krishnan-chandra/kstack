/**
 * Handoff extension — continue in a lean session that references the previous
 * session instead of copying or summarizing its conversation history.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff --model anthropic/claude-sonnet-4-5 execute phase one of the plan
 *   /handoff                        # continue from the prior resume point
 *
 * Model selection: with `--model`, the replacement session starts on that
 * model; without it, the replacement session inherits the parent session's
 * active model. Both paths go through `pi.setModel()` before `newSession()`.
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
import { formatModelRef, parseHandoffArgs, resolveModelReference, type HandoffModel } from "./model-selection.ts";

/**
 * Build the command handler separately so lifecycle behavior is easy to test.
 *
 * The handler needs `pi.setModel` to control the replacement session's model:
 * `ctx.newSession()` takes no model option, and a brand-new session resolves
 * its model from the configured default. `setModel` persists that default,
 * so applying it before `newSession` determines the replacement's model.
 */
export function createHandoffHandler(api: Pick<ExtensionAPI, "setModel">) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("handoff requires interactive mode", "error");
			return;
		}

		const parsed = parseHandoffArgs(args);
		if (!parsed.ok) {
			ctx.ui.notify(parsed.error, "error");
			return;
		}

		const goal = parsed.goal.trim() || DEFAULT_HANDOFF_GOAL;

		// Resolve an explicit model before opening the editor so a typo fails
		// fast. The actual switch is deferred until after the user confirms the
		// prompt, so cancelling never changes the parent session's model.
		let targetModel: HandoffModel | undefined;
		if (parsed.modelRef !== undefined) {
			const resolution = resolveModelReference(ctx.modelRegistry.getAll() as HandoffModel[], parsed.modelRef);
			if (resolution.status === "not-found") {
				ctx.ui.notify(`Unknown model "${parsed.modelRef}". Use provider/model-id; see /model for available models.`, "error");
				return;
			}
			if (resolution.status === "ambiguous") {
				const options = resolution.matches.slice(0, 8).map(formatModelRef).join(", ");
				ctx.ui.notify(`Model "${parsed.modelRef}" is ambiguous. Matches: ${options}. Use provider/model-id.`, "error");
				return;
			}
			targetModel = resolution.model;
		}

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

		if (targetModel) {
			let switched = false;
			try {
				switched = await api.setModel(targetModel);
			} catch (err) {
				ctx.ui.notify(
					`Could not switch to ${formatModelRef(targetModel)}: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}
			if (!switched) {
				ctx.ui.notify(`No API key available for ${formatModelRef(targetModel)}; handoff cancelled`, "error");
				return;
			}
		} else if (ctx.model) {
			// Inherit the parent session's model. A fresh session resolves its
			// model from the configured default, which can lag the active
			// session (e.g. after `pi --model` or resuming another session),
			// so pin it explicitly. Best effort: if this fails, fall back to
			// Pi's normal default resolution instead of blocking the handoff.
			try {
				await api.setModel(ctx.model);
			} catch {
				// Ignore; the replacement session still gets the configured default.
			}
		}

		const modelNote = targetModel ? ` Model: ${formatModelRef(targetModel)}.` : "";
		const result = await ctx.newSession({
			parentSession: oldFile,
			setup: async (sm) => {
				sm.appendCustomMessageEntry("handoff", historyRef, true, source);
			},
			withSession: async (fresh) => {
				fresh.ui.setEditorText(edited);
				fresh.ui.notify(`Handoff ready.${modelNote} Previous session: ${oldFile}`, "info");
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
		description:
			"Continue in a lean session linked to the current session's history (optional --model provider/model-id)",
		handler: createHandoffHandler(pi),
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
