/**
 * Build the command handler separately so lifecycle behavior is easy to test.
 *
 * Model and effort selection is applied inside `withSession`, after Pi has
 * created the replacement runtime: `ctx.newSession()` takes neither option and
 * a brand-new session starts on the configured defaults, so nothing recorded
 * during setup can steer the already-created runtime. Pi re-runs extension
 * factories for every replacement runtime, sometimes through an isolated
 * module graph. The factory publishes its live API through the process-wide
 * rendezvous in replacement-selection-api.ts. The predecessor's handler reads
 * that API after replacement, then records the model and effort only in the
 * replacement transcript. It never changes the predecessor or persisted
 * defaults.
 */

import { existsSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getArchiveDbPath, getArchiveRoot } from "../session-archive/archive-files.ts";
import { archiveCurrentSession } from "../session-archive/archive-ops.ts";
import { loadKstackRoot } from "../shared/kstack-config.ts";
import { collectCatalogueNameAliases, collectKstackModelAliases } from "../shared/model-aliases.ts";
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
	resolveModelReference,
} from "./model-selection.ts";
import { getReplacementSelectionApi, type ReplacementSelectionApi } from "./replacement-selection-api.ts";

type HandoffApi = { getThinkingLevel(): string };

export function createHandoffHandler(
	api: HandoffApi,
	deps: {
		sourceExists?: (path: string) => boolean;
		getReplacementApi?: (sessionId: string) => ReplacementSelectionApi | undefined;
	} = {},
) {
	const sourceExists = deps.sourceExists ?? existsSync;
	const getReplacementApi = deps.getReplacementApi ?? getReplacementSelectionApi;
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
			// Short names come from kstack.json {label, model, thinking?} entries
			// and from model display names; both resolve against the same catalogue.
			const kstackRoot = loadKstackRoot();
			const aliases = [
				...(kstackRoot.status === "found" ? collectKstackModelAliases(kstackRoot.root) : []),
				...collectCatalogueNameAliases(catalogue),
			];
			const resolution = resolveModelReference(catalogue, parsed.modelRef, aliases);
			if (resolution.status === "not-found") {
				const hint = scopedActive
					? " Model scoping is active, so only scoped models are accepted (see /scoped-models)."
					: " Use provider/model-id, a kstack.json model label, or a model display name (quote names with spaces), optionally with :<effort>; see /model for available models.";
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
		if (!sourceExists(oldFile)) {
			ctx.ui.notify(`The source session no longer exists at ${oldFile}; cannot create a durable handoff.`, "error");
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
		const expectedModel = targetModel ?? previousModel;
		const expectedEffort = requestedEffort ?? previousEffort;

		let result: { cancelled: boolean };
		const sessionOptions: NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]> = {
			parentSession: oldFile,
			setup: async (sm) => {
				sm.appendSessionInfo(replacementSessionName);
				sm.appendCustomMessageEntry("handoff", historyRef, true, source);
			},
			withSession: async (fresh) => {
				// A brand-new session starts on the configured defaults, so switch
				// it here through its own live API: Pi rebuilt the extension
				// runtime for the replacement before withSession runs, and the
				// factory rebinding points at that runtime. Model first so Pi
				// clamps effort against the selected model's capabilities. Both
				// calls append to the replacement transcript only; failures fall
				// through to the effective-state report below.
				const replacement = getReplacementApi(fresh.sessionManager.getSessionId());
				let selectionFailure: string | undefined;
				if (expectedModel || expectedEffort) {
					if (!replacement) {
						selectionFailure = "the replacement session API is unavailable";
					} else {
						if (expectedModel && !(fresh.model && sameModel(fresh.model as HandoffModel, expectedModel))) {
							try {
								const switched = await replacement.setModel(expectedModel);
								if (!switched) selectionFailure = `no credentials for ${formatModelRef(expectedModel)}`;
							} catch (err) {
								selectionFailure = err instanceof Error ? err.message : String(err);
							}
						}
						if (expectedEffort) {
							try {
								replacement.setThinkingLevel(expectedEffort);
							} catch (err) {
								selectionFailure ??= err instanceof Error ? err.message : String(err);
							}
						}
					}
				}

				// Report the effective replacement state. Pi can reject or clamp a
				// selection when the model is unavailable, unauthenticated, or
				// lacks the requested effort level.
				const actual = fresh.model;
				const actualEffort = readFreshEffort(fresh.thinkingLevel);
				const modelMismatch = Boolean(expectedModel && actual && !sameModel(actual, expectedModel));
				const effortMismatch = Boolean(expectedEffort && actualEffort && actualEffort !== expectedEffort);
				if ((modelMismatch || effortMismatch) && actual) {
					const actualLabel = formatModelEffort(actual, actualEffort);
					const expectedLabel = expectedModel
						? formatModelEffort(expectedModel, expectedEffort)
						: (expectedEffort ?? "the requested selection");
					const failureSuffix = selectionFailure === undefined ? "" : ` (${selectionFailure})`;
					fresh.ui.notify(
						`Handoff started, but the replacement could not apply ${expectedLabel}; it is on ${actualLabel}${failureSuffix}. Previous session: ${oldFile}`,
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

		if (result.cancelled) ctx.ui.notify("New session cancelled", "info");
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

export function requireHandoffSource(ctx: { sessionManager: { getBranch(): unknown[] } }): HandoffSource {
	const source = findHandoffSource(ctx.sessionManager.getBranch() as never[]);
	if (!source) {
		throw new Error("No handoff history is linked to this session. Run /handoff from a persisted session first.");
	}
	return source;
}
