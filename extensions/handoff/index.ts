/**
 * Handoff extension — continue in a lean session that references the previous
 * session instead of copying or summarizing its conversation history.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff --model anthropic/claude-sonnet-4-5 execute phase one of the plan
 *   /handoff --model openai/gpt-5.2:high continue the work
 *   /handoff                        # continue from the prior resume point
 *
 * Saving the editor is the only confirmation. The replacement session starts
 * immediately with that prompt; cancelling the editor leaves the old session.
 *
 * Model and effort selection: `--model` accepts `provider/model-id` or
 * `provider/model-id:<effort>` using Pi thinking levels (`off`, `minimal`,
 * `low`, `medium`, `high`, `xhigh`, `max`). Without a suffix, the parent
 * session's effective effort is inherited. Without `--model`, both the parent
 * model and its effort are pinned (best effort). Model is applied first so
 * effort is clamped against the selected model's capabilities. Startup-level
 * overrides — a `pi --model` CLI flag, `--thinking`, or model scoping
 * (`--models` / `enabledModels`) — take precedence; the handler compares the
 * replacement session's actual model and effort against the expectation and
 * reports any mismatch instead of claiming success.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deriveSessionName } from "../shared/session-name.ts";
import { buildReferenceHandoffPrompt, DEFAULT_HANDOFF_GOAL, formatHistoryReference } from "./handoff-context.ts";
import { findHandoffSource, type HandoffSource, readHandoffHistory, searchHandoffHistory } from "./history-reader.ts";
import {
	formatModelEffort,
	formatModelRef,
	type HandoffEffortLevel,
	type HandoffModel,
	isHandoffEffortLevel,
	parseHandoffArgs,
	pinHandoffEffort,
	resolveModelReference,
} from "./model-selection.ts";

/**
 * Build the command handler separately so lifecycle behavior is easy to test.
 *
 * The handler needs `pi.setModel` and `pi.setThinkingLevel` to control the
 * replacement session's model and effort: `ctx.newSession()` takes neither
 * option, and a brand-new session resolves both from the configured defaults.
 * Those setters persist the defaults, so applying the model first and the
 * effort second before `newSession` determines the replacement's state in the
 * default configuration. A startup `--model` / `--thinking` flag or active
 * model scoping still wins; the handler detects that from the replacement
 * session's actual model and thinking level and warns instead of claiming
 * success.
 */
type HandoffApi = Pick<ExtensionAPI, "setModel"> & {
	getThinkingLevel(): string;
	setThinkingLevel(level: string): void;
};

export function createHandoffHandler(api: HandoffApi) {
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

		// Resolve an explicit model/effort before opening the editor so a typo
		// fails fast. The actual switch is deferred until after the editor is
		// saved, so cancelling never changes the parent session. When model
		// scoping is active, only scoped models are valid choices: anything
		// else would be silently replaced in the new session.
		let targetModel: HandoffModel | undefined;
		let requestedEffort: HandoffEffortLevel | undefined;
		if (parsed.modelRef !== undefined) {
			const scoped = ctx.scopedModels ?? [];
			const scopedActive = scoped.length > 0;
			const catalogue: HandoffModel[] = scopedActive
				? scoped.map((s) => s.model)
				: (ctx.modelRegistry.getAll() as HandoffModel[]);
			const resolution = resolveModelReference(catalogue, parsed.modelRef);
			if (resolution.status === "not-found") {
				const hint = scopedActive
					? " Model scoping is active, so only scoped models are accepted (see /scoped-models)."
					: " Use provider/model-id or provider/model-id:<effort>; see /model for available models.";
				ctx.ui.notify(`Unknown model "${parsed.modelRef}".${hint}`, "error");
				return;
			}
			if (resolution.status === "ambiguous") {
				const options = resolution.matches.slice(0, 8).map(formatModelRef).join(", ");
				ctx.ui.notify(`Model "${parsed.modelRef}" is ambiguous. Matches: ${options}. Use provider/model-id.`, "error");
				return;
			}
			targetModel = resolution.model;
			requestedEffort = resolution.effort;
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
		const editedGoal = edited.match(/^## Goal\s*\n+([^\n]+)/m)?.[1]?.trim();
		const replacementSessionName = deriveSessionName(editedGoal || goal);

		const previousModel = ctx.model;
		const previousEffort = readEffort(ctx.thinkingLevel, api);
		const targetEffort = requestedEffort ?? previousEffort;
		let appliedEffort: HandoffEffortLevel | undefined;

		if (targetModel) {
			let switched = false;
			try {
				switched = await api.setModel(targetModel as Parameters<ExtensionAPI["setModel"]>[0]);
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

		// Pin effort after the model so Pi clamps against the selected model's
		// capabilities. Inherit the parent effort when the reference has no
		// suffix, including when --model is omitted.
		if (targetEffort) {
			try {
				appliedEffort = pinHandoffEffort(api, targetEffort);
			} catch (err) {
				ctx.ui.notify(
					`Could not set effort ${targetEffort}: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				await restoreParentState(api, {
					targetModel,
					previousModel,
					previousEffort,
					effortChanged: requestedEffort !== undefined || Boolean(previousEffort),
				});
				return;
			}
			if (requestedEffort && appliedEffort !== requestedEffort) {
				ctx.ui.notify(
					`Requested effort ${requestedEffort} is not supported; using ${appliedEffort} instead`,
					"warning",
				);
			}
		}

		// An explicit --model / effort switch changes the parent session before
		// replacement. If the replacement does not happen, restore both so a
		// cancelled or failed handoff leaves neither the parent session nor the
		// persisted defaults changed. Restore model first: model restoration
		// can itself clamp effort. There is nothing to restore to when no model
		// was active before; the parent then keeps the requested model/effort.
		const restoreParent = async (): Promise<void> => {
			await restoreParentState(api, {
				targetModel,
				previousModel,
				previousEffort,
				effortChanged: appliedEffort !== undefined,
			});
		};

		let result: { cancelled: boolean };
		let replacementSessionStarted = false;
		try {
			result = await ctx.newSession({
				parentSession: oldFile,
				setup: async (sm) => {
					sm.appendSessionInfo(replacementSessionName);
					sm.appendCustomMessageEntry("handoff", historyRef, true, source);
				},
				withSession: async (fresh) => {
					replacementSessionStarted = true;
					// Report the model and effort the replacement session actually
					// started on. A startup --model / --thinking flag or active
					// model scoping can override the switch made above; never
					// claim otherwise.
					const actual = fresh.model;
					const actualEffort = readFreshEffort(fresh.thinkingLevel);
					const expectedModel = targetModel ?? previousModel;
					const expectedEffort = appliedEffort;
					const modelMismatch = Boolean(expectedModel && actual && !sameModel(actual, expectedModel));
					const effortMismatch = Boolean(expectedEffort && actualEffort && actualEffort !== expectedEffort);
					if ((modelMismatch || effortMismatch) && actual) {
						const actualLabel = formatModelEffort(actual, actualEffort);
						const expectedLabel = expectedModel
							? formatModelEffort(expectedModel, expectedEffort)
							: (expectedEffort ?? "the requested selection");
						const reason = targetModel
							? "a startup --model/--thinking flag or model scoping overrides handoff selection"
							: "a startup --model/--thinking flag or model scoping overrides inheritance";
						fresh.ui.notify(
							`Handoff started, but the session is on ${actualLabel} instead of ${expectedLabel} (${reason}). Previous session: ${oldFile}`,
							"warning",
						);
					} else if (actual && (targetModel || expectedEffort)) {
						const label = formatModelEffort(actual, actualEffort ?? expectedEffort);
						fresh.ui.notify(`Handoff started. Model: ${label}. Previous session: ${oldFile}`, "info");
					} else {
						fresh.ui.notify(`Handoff started. Previous session: ${oldFile}`, "info");
					}
					// The editor already confirmed this text. Check the failures Pi
					// raises before accepting a user message, and only restore the
					// editor for those known pre-submission failures. Once sending
					// starts, an error may occur after the message was persisted, so
					// restoring it could create a duplicate turn on retry.
					const leavePromptInEditor = (reason: string): void => {
						fresh.ui.setEditorText(edited);
						fresh.ui.notify(`Handoff prompt is ready to submit: ${reason}`, "warning");
					};
					if (!actual) {
						leavePromptInEditor("No model selected");
						return;
					}

					let hasAuth = fresh.modelRegistry.hasConfiguredAuth(actual);
					if (!hasAuth) {
						try {
							hasAuth = (await fresh.modelRegistry.getProviderAuth(actual.provider)) !== undefined;
						} catch (err) {
							leavePromptInEditor(`Could not resolve credentials: ${err instanceof Error ? err.message : String(err)}`);
							return;
						}
					}
					if (!hasAuth) {
						leavePromptInEditor(`No credentials available for ${formatModelRef(actual)}`);
						return;
					}

					await fresh.sendUserMessage(edited);
				},
			});
		} catch (err) {
			// Once withSession begins, the old API is stale. In particular, a
			// send failure must propagate without trying to restore the old model.
			if (!replacementSessionStarted) await restoreParent();
			throw err;
		}

		if (result.cancelled) {
			await restoreParent();
			if (targetModel && !previousModel) {
				const kept = formatModelEffort(targetModel, appliedEffort);
				ctx.ui.notify(`New session cancelled; the parent session keeps ${kept}`, "info");
			} else {
				ctx.ui.notify("New session cancelled", "info");
			}
		}
	};
}

function sameModel(a: HandoffModel, b: HandoffModel): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function readEffort(fromContext: unknown, api: Pick<HandoffApi, "getThinkingLevel">): HandoffEffortLevel | undefined {
	if (typeof fromContext === "string" && isHandoffEffortLevel(fromContext)) return fromContext;
	try {
		const fromApi = api.getThinkingLevel();
		return isHandoffEffortLevel(fromApi) ? fromApi : undefined;
	} catch {
		return undefined;
	}
}

function readFreshEffort(fromContext: unknown): HandoffEffortLevel | undefined {
	return typeof fromContext === "string" && isHandoffEffortLevel(fromContext) ? fromContext : undefined;
}

async function restoreParentState(
	api: Pick<HandoffApi, "setModel" | "setThinkingLevel">,
	state: {
		targetModel: HandoffModel | undefined;
		previousModel: HandoffModel | undefined;
		previousEffort: HandoffEffortLevel | undefined;
		effortChanged: boolean;
	},
): Promise<void> {
	const { targetModel, previousModel, previousEffort, effortChanged } = state;
	if (targetModel && previousModel && !sameModel(previousModel, targetModel)) {
		try {
			await api.setModel(previousModel as Parameters<ExtensionAPI["setModel"]>[0]);
		} catch {
			// Best effort; the parent keeps the requested model.
		}
	}
	if (effortChanged && previousEffort) {
		try {
			api.setThinkingLevel(previousEffort);
		} catch {
			// Best effort; the parent keeps the requested effort.
		}
	}
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
			"Continue in a lean session linked to the current session's history (optional --model provider/model-id[:effort])",
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
