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
 * model; without it, the parent session's active model is pinned (best
 * effort) so the replacement inherits it. Both paths go through
 * `pi.setModel()` before `newSession()`. Startup-level overrides — a
 * `pi --model` CLI flag or model scoping (`--models` / `enabledModels`) —
 * take precedence over this mechanism; the handler compares the replacement
 * session's actual model against the expectation and reports any mismatch
 * instead of claiming success.
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
import { handoffSessionName } from "../session-naming/names.ts";
import { formatModelRef, parseHandoffArgs, resolveModelReference, type HandoffModel } from "./model-selection.ts";

/**
 * Build the command handler separately so lifecycle behavior is easy to test.
 *
 * The handler needs `pi.setModel` to control the replacement session's model:
 * `ctx.newSession()` takes no model option, and a brand-new session resolves
 * its model from the configured default. `setModel` persists that default,
 * so applying it before `newSession` determines the replacement's model in
 * the default configuration. A startup `--model` flag or active model
 * scoping still wins over this mechanism; the handler detects that from the
 * replacement session's actual model and warns instead of claiming success.
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
		// prompt, so cancelling the editor never changes the parent session's
		// model. When model scoping is active, only scoped models are valid
		// choices: anything else would be silently replaced in the new session.
		let targetModel: HandoffModel | undefined;
		if (parsed.modelRef !== undefined) {
			const scoped = (ctx.scopedModels ?? []) as Array<{ model: HandoffModel }>;
			const scopedActive = scoped.length > 0;
			const catalogue: HandoffModel[] = scopedActive
				? scoped.map((s) => s.model)
				: (ctx.modelRegistry.getAll() as HandoffModel[]);
			const resolution = resolveModelReference(catalogue, parsed.modelRef);
			if (resolution.status === "not-found") {
				const hint = scopedActive
					? " Model scoping is active, so only scoped models are accepted (see /scoped-models)."
					: " Use provider/model-id; see /model for available models.";
				ctx.ui.notify(`Unknown model "${parsed.modelRef}".${hint}`, "error");
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
		const parentName = ctx.sessionManager.getSessionName();
		const replacementName = handoffSessionName(goal, DEFAULT_HANDOFF_GOAL, parentName, oldId);
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

		const previousModel = ctx.model;

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
		} else if (previousModel) {
			// Inherit the parent session's model. A fresh session resolves its
			// model from the configured default, which can lag the active
			// session (e.g. after resuming another session), so pin it
			// explicitly. Best effort: if the pin fails (e.g. credentials were
			// removed mid-session), fall back to Pi's normal default resolution
			// instead of blocking the handoff.
			let pinned = false;
			try {
				pinned = await api.setModel(previousModel);
			} catch {
				// Treated like a false result below.
			}
			if (!pinned) {
				ctx.ui.notify(
					`Could not pin ${formatModelRef(previousModel)} for the new session; it will start on the configured default model`,
					"warning",
				);
			}
		}

		// An explicit --model switches the parent session before replacement.
		// If the replacement does not happen, switch back so a cancelled or
		// failed handoff leaves neither the parent session nor the persisted
		// default model changed. There is nothing to restore to when no model
		// was active before; the parent then keeps the requested model.
		const restoreParentModel = async (): Promise<void> => {
			if (!targetModel || !previousModel) return;
			if (sameModel(previousModel, targetModel)) return;
			try {
				await api.setModel(previousModel);
			} catch {
				// Best effort; the parent keeps the requested model.
			}
		};

		let result: { cancelled: boolean };
		try {
			result = await ctx.newSession({
				parentSession: oldFile,
				setup: async (sm) => {
					sm.appendSessionInfo(replacementName);
					sm.appendCustomMessageEntry("handoff", historyRef, true, source);
				},
				withSession: async (fresh) => {
					fresh.ui.setEditorText(edited);
					// Report the model the replacement session actually started
					// on. A startup --model flag or active model scoping can
					// override the switch made above; never claim otherwise.
					const actual = fresh.model as HandoffModel | undefined;
					if (targetModel) {
						if (actual && !sameModel(actual, targetModel)) {
							fresh.ui.notify(
								`Handoff ready, but the session started on ${formatModelRef(actual)} instead of ${formatModelRef(targetModel)} (a startup --model flag or model scoping overrides handoff selection). Previous session: ${oldFile}`,
								"warning",
							);
						} else {
							fresh.ui.notify(`Handoff ready. Model: ${formatModelRef(targetModel)}. Previous session: ${oldFile}`, "info");
						}
					} else if (previousModel && actual && !sameModel(actual, previousModel)) {
						fresh.ui.notify(
							`Handoff ready, but the session started on ${formatModelRef(actual)} instead of the parent's ${formatModelRef(previousModel)} (a startup --model flag or model scoping overrides inheritance). Previous session: ${oldFile}`,
							"warning",
						);
					} else {
						fresh.ui.notify(`Handoff ready. Previous session: ${oldFile}`, "info");
					}
				},
			});
		} catch (err) {
			await restoreParentModel();
			throw err;
		}

		if (result.cancelled) {
			await restoreParentModel();
			if (targetModel && !previousModel) {
				ctx.ui.notify(`New session cancelled; the parent session keeps ${formatModelRef(targetModel)}`, "info");
			} else {
				ctx.ui.notify("New session cancelled", "info");
			}
		}
	};
}

function sameModel(a: HandoffModel, b: HandoffModel): boolean {
	return a.provider === b.provider && a.id === b.id;
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
