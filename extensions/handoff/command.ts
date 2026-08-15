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

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getArchiveDbPath, getArchiveRoot } from "../session-archive/archive-files.ts";
import { archiveCurrentSession } from "../session-archive/archive-ops.ts";
import { deriveSessionName } from "../shared/session-name.ts";
import { buildReferenceHandoffPrompt, DEFAULT_HANDOFF_GOAL, formatHistoryReference } from "./handoff-context.ts";
import { findHandoffSource, type HandoffSource } from "./history-reader.ts";
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
		const baseHistoryRef = formatHistoryReference(oldFile, oldId, cwd);
		const historyRef = parsed.archive
			? `${baseHistoryRef}\nStorage: archived before this handoff; use the archive fallback by exact session ID.`
			: baseHistoryRef;
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
		const sessionOptions: Parameters<ExtensionCommandContext["newSession"]>[0] = {
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
		};
		try {
			if (parsed.archive) {
				const archiveRoot = getArchiveRoot();
				let continueInFresh: (() => Promise<void>) | undefined;
				const archiveResult = await archiveCurrentSession({
					deps: { archiveRoot, dbPath: getArchiveDbPath(archiveRoot) },
					snapshot: {
						sourcePath: oldFile,
						sessionId: oldId,
						sessionDir: ctx.sessionManager.getSessionDir(),
						sessionName: ctx.sessionManager.getSessionName()?.trim() || undefined,
					},
					waitForIdle: () => ctx.waitForIdle(),
					confirm: (title, message) => ctx.ui.confirm(title, message),
					skipConfirmation: true,
					notify: (message, level) => ctx.ui.notify(message, level),
					startNewSession: (archiveInFresh) =>
						ctx.newSession({
							// The active parent path is moved before continuation; the
							// structured handoff metadata preserves durable provenance.
							...sessionOptions,
							parentSession: undefined,
							withSession: async (fresh) => {
								continueInFresh = () => sessionOptions.withSession?.(fresh) ?? Promise.resolve();
								await archiveInFresh({ notify: (message, level) => fresh.ui.notify(message, level) });
							},
						}),
					afterArchive: async () => {
						await continueInFresh?.();
					},
				});
				result = { cancelled: archiveResult.status === "cancelled" };
			} else {
				result = await ctx.newSession(sessionOptions);
			}
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

export function requireHandoffSource(ctx: { sessionManager: { getBranch(): unknown[] } }): HandoffSource {
	const source = findHandoffSource(ctx.sessionManager.getBranch() as never[]);
	if (!source) {
		throw new Error("No handoff history is linked to this session. Run /handoff from a persisted session first.");
	}
	return source;
}
