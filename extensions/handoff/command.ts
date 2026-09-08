import { type BoundaryValue, isString } from "../shared/validation.ts";
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

import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getArchiveDbPath, getArchiveRoot } from "../session-archive/archive-files.ts";
import { archiveCurrentSession } from "../session-archive/archive-ops.ts";
import { loadKstackRoot } from "../shared/kstack-config.ts";
import { collectCatalogueNameAliases, collectKstackModelAliases } from "../shared/model-aliases.ts";
import { isRecord } from "../shared/narrow.ts";
import { deriveSessionName } from "../shared/session-name.ts";
import { buildReferenceHandoffPrompt, DEFAULT_HANDOFF_GOAL, formatHistoryReference } from "./handoff-context.ts";
import {
	findHandoffSource,
	type HandoffBranchEntry,
	type HandoffHistoryPreflight,
	type HandoffSource,
	preflightHandoffHistory,
} from "./history-reader.ts";
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

interface HandoffSessionResult {
	cancelled: boolean;
}

interface HandoffModelSelection {
	targetModel: HandoffModel | undefined;
	requestedEffort: HandoffEffortLevel | undefined;
}

interface HandoffPlan {
	source: HandoffSource;
	historyRef: string;
	edited: string;
	replacementSessionName: string;
	expectedModel: HandoffModel | undefined;
	expectedEffort: HandoffEffortLevel | undefined;
	targetModel: HandoffModel | undefined;
}

type HandoffSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type FreshSessionContext = Parameters<NonNullable<HandoffSessionOptions["withSession"]>>[0];

export function createHandoffHandler(
	api: HandoffApi,
	deps: {
		preflightHistory?: (source: HandoffSource) => HandoffHistoryPreflight;
		getReplacementApi?: (sessionId: string) => ReplacementSelectionApi | undefined;
	} = {},
) {
	const preflightHistory = deps.preflightHistory ?? preflightHandoffHistory;
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
		const modelSelection = resolveHandoffModelSelection(ctx, parsed.modelRef);
		if (modelSelection === undefined) return;

		await ctx.waitForIdle();

		const source = prepareHandoffSource(ctx, parsed.archive, preflightHistory);
		if (source === undefined) return;

		const historyRef = buildHandoffHistoryRef(parsed.archive, source);
		const edited = await promptHandoffEditor(ctx, goal, historyRef);
		if (edited === undefined) return;

		const plan = buildHandoffPlan({
			api,
			ctx,
			edited,
			goal,
			historyRef,
			source,
			...modelSelection,
		});
		const sessionOptions = buildHandoffSessionOptions(plan, getReplacementApi);

		const result = parsed.archive
			? await startArchivedHandoff(ctx, plan, sessionOptions)
			: await startDirectHandoff(ctx, source, edited, sessionOptions, preflightHistory);
		if (result === undefined) return;

		if (result.cancelled) ctx.ui.notify("New session cancelled", "info");
	};
}

function resolveHandoffModelSelection(
	ctx: ExtensionCommandContext,
	modelRef: string | undefined,
): HandoffModelSelection | undefined {
	if (modelRef === undefined) {
		return { targetModel: undefined, requestedEffort: undefined };
	}

	const scoped = ctx.scopedModels ?? [];
	const scopedActive = scoped.length > 0;
	// SAFETY: Pi's model registry owns every model returned by getAll.
	const catalogue: HandoffModel[] = scopedActive
		? scoped.map((s) => s.model)
		: /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (ctx.modelRegistry.getAll() as HandoffModel[]);
	const kstackRoot = loadKstackRoot();
	const aliases = [
		...(kstackRoot.status === "found" ? collectKstackModelAliases(kstackRoot.root) : []),
		...collectCatalogueNameAliases(catalogue),
	];
	const resolution = resolveModelReference(catalogue, modelRef, aliases);
	if (resolution.status === "not-found") {
		const hint = scopedActive
			? " Model scoping is active, so only scoped models are accepted (see /scoped-models)."
			: " Use provider/model-id, a kstack.json model label, or a model display name (quote names with spaces), optionally with :<effort>; see /model for available models.";
		ctx.ui.notify(`Unknown model "${modelRef}".${hint}`, "error");
		return undefined;
	}
	if (resolution.status === "ambiguous") {
		const options = resolution.matches.slice(0, 8).map(formatModelRef).join(", ");
		ctx.ui.notify(`Model "${modelRef}" is ambiguous. Matches: ${options}. Use provider/model-id.`, "error");
		return undefined;
	}
	return { targetModel: resolution.model, requestedEffort: resolution.effort };
}

function prepareHandoffSource(
	ctx: ExtensionCommandContext,
	archive: boolean,
	preflightHistory: (source: HandoffSource) => HandoffHistoryPreflight,
): HandoffSource | undefined {
	const oldFile = ctx.sessionManager.getSessionFile();
	if (oldFile === undefined) {
		ctx.ui.notify("handoff requires a persisted session and is unavailable with --no-session", "error");
		return undefined;
	}
	const source: HandoffSource = {
		version: 1,
		sessionFile: oldFile,
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
	};
	if (!archive) {
		const preflight = preflightHistory(source);
		if (preflight.kind === "rejected") {
			ctx.ui.notify(`Cannot create a durable handoff: ${preflight.reason}`, "error");
			return undefined;
		}
	}
	return source;
}

function buildHandoffHistoryRef(archive: boolean, source: HandoffSource): string {
	const baseHistoryRef = formatHistoryReference(source.sessionFile, source.sessionId, source.cwd);
	if (!archive) return baseHistoryRef;
	return `${baseHistoryRef}\nStorage: archived before this handoff; use the archive fallback by exact session ID.`;
}

async function promptHandoffEditor(
	ctx: ExtensionCommandContext,
	goal: string,
	historyRef: string,
): Promise<string | undefined> {
	const draft = buildReferenceHandoffPrompt(goal, historyRef);
	const edited = await ctx.ui.editor("Edit handoff prompt", draft);
	if (edited === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return undefined;
	}
	if (edited.trim() === "") {
		ctx.ui.notify("Handoff prompt cannot be empty", "error");
		return undefined;
	}
	return edited;
}

function buildHandoffPlan(input: {
	api: HandoffApi;
	ctx: ExtensionCommandContext;
	edited: string;
	goal: string;
	historyRef: string;
	source: HandoffSource;
	targetModel: HandoffModel | undefined;
	requestedEffort: HandoffEffortLevel | undefined;
}): HandoffPlan {
	const editedGoal = input.edited.match(/^## Goal\s*\n+([^\n]+)/m)?.[1]?.trim();
	const previousModel = input.ctx.model;
	const previousEffort = readEffort(input.ctx.thinkingLevel, input.api);
	return {
		source: input.source,
		historyRef: input.historyRef,
		edited: input.edited,
		replacementSessionName: deriveSessionName(editedGoal || input.goal),
		expectedModel: input.targetModel ?? previousModel,
		expectedEffort: input.requestedEffort ?? previousEffort,
		targetModel: input.targetModel,
	};
}

function buildHandoffSessionOptions(
	plan: HandoffPlan,
	getReplacementApi: (sessionId: string) => ReplacementSelectionApi | undefined,
): HandoffSessionOptions {
	return {
		parentSession: plan.source.sessionFile,
		setup: async (sm) => {
			sm.appendSessionInfo(plan.replacementSessionName);
			sm.appendCustomMessageEntry("handoff", plan.historyRef, true, plan.source);
		},
		withSession: (fresh) => runReplacementHandoff(fresh, plan, getReplacementApi),
	};
}

async function startArchivedHandoff(
	ctx: ExtensionCommandContext,
	plan: HandoffPlan,
	sessionOptions: HandoffSessionOptions,
): Promise<HandoffSessionResult> {
	const archiveRoot = getArchiveRoot();
	let continueInFresh: (() => Promise<void>) | undefined;
	const archiveResult = await archiveCurrentSession({
		deps: { archiveRoot, dbPath: getArchiveDbPath(archiveRoot) },
		snapshot: {
			sourcePath: plan.source.sessionFile,
			sessionId: plan.source.sessionId,
			sessionDir: ctx.sessionManager.getSessionDir(),
			sessionName: ctx.sessionManager.getSessionName()?.trim() || undefined,
		},
		waitForIdle: () => ctx.waitForIdle(),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		skipConfirmation: true,
		notify: (message, level) => ctx.ui.notify(message, level),
		startNewSession: (archiveInFresh) =>
			ctx.newSession({
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
	return { cancelled: archiveResult.status === "cancelled" };
}

async function startDirectHandoff(
	ctx: ExtensionCommandContext,
	source: HandoffSource,
	edited: string,
	sessionOptions: HandoffSessionOptions,
	preflightHistory: (source: HandoffSource) => HandoffHistoryPreflight,
): Promise<HandoffSessionResult | undefined> {
	const preflight = preflightHistory(source);
	if (preflight.kind === "rejected") {
		ctx.ui.setEditorText(edited);
		ctx.ui.notify(`Cannot create a durable handoff: ${preflight.reason}`, "error");
		return undefined;
	}
	return await ctx.newSession(sessionOptions);
}

async function runReplacementHandoff(
	fresh: FreshSessionContext,
	plan: HandoffPlan,
	getReplacementApi: (sessionId: string) => ReplacementSelectionApi | undefined,
): Promise<void> {
	const selectionFailure = await applyReplacementModelSelection(fresh, plan, getReplacementApi);
	notifyHandoffStart(fresh, plan, selectionFailure);
	await submitHandoffPrompt(fresh, plan.edited);
}

async function applyReplacementModelSelection(
	fresh: FreshSessionContext,
	plan: HandoffPlan,
	getReplacementApi: (sessionId: string) => ReplacementSelectionApi | undefined,
): Promise<string | undefined> {
	const { expectedModel, expectedEffort } = plan;
	if (!expectedModel && !expectedEffort) return undefined;

	const replacement = getReplacementApi(fresh.sessionManager.getSessionId());
	if (!replacement) return "the replacement session API is unavailable";

	let selectionFailure: string | undefined;
	if (
		expectedModel &&
		!(
			fresh.model &&
			sameModel(
				/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ fresh.model as HandoffModel,
				expectedModel,
			)
		)
	) {
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
	return selectionFailure;
}

function notifyHandoffStart(fresh: FreshSessionContext, plan: HandoffPlan, selectionFailure: string | undefined): void {
	const { expectedModel, expectedEffort, targetModel, source } = plan;
	const actual = fresh.model;
	const actualEffort = readEffort(fresh.thinkingLevel);
	const oldFile = source.sessionFile;
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
		return;
	}
	if (actual && (targetModel || expectedEffort)) {
		const label = formatModelEffort(actual, actualEffort ?? expectedEffort);
		fresh.ui.notify(`Handoff started. Model: ${label}. Previous session: ${oldFile}`, "info");
		return;
	}
	fresh.ui.notify(`Handoff started. Previous session: ${oldFile}`, "info");
}

async function submitHandoffPrompt(fresh: FreshSessionContext, edited: string): Promise<void> {
	const leavePromptInEditor = (reason: string): void => {
		fresh.ui.setEditorText(edited);
		fresh.ui.notify(`Handoff prompt is ready to submit: ${reason}`, "warning");
	};

	const actual = fresh.model;
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

	try {
		await fresh.sendUserMessage(edited);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		fresh.ui.notify(
			`Handoff message submission failed: ${message}. Inspect the replacement conversation before submitting again.`,
			"error",
		);
		throw err;
	}
}

function sameModel(a: HandoffModel, b: HandoffModel): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function readEffort(
	fromContext: BoundaryValue,
	api?: Pick<HandoffApi, "getThinkingLevel">,
): HandoffEffortLevel | undefined {
	if (isString(fromContext) && isHandoffEffortLevel(fromContext)) return fromContext;
	if (!api) return undefined;
	try {
		const fromApi = api.getThinkingLevel();
		return isHandoffEffortLevel(fromApi) ? fromApi : undefined;
	} catch {
		return undefined;
	}
}

function handoffBranchEntry(entry: SessionEntry): HandoffBranchEntry {
	if (entry.type !== "custom_message") return { type: entry.type };
	return {
		type: entry.type,
		customType: entry.customType,
		details: isRecord(entry.details) ? entry.details : undefined,
	};
}

export function requireHandoffSource(ctx: { sessionManager: { getBranch(): readonly SessionEntry[] } }): HandoffSource {
	const source = findHandoffSource(ctx.sessionManager.getBranch().map(handoffBranchEntry));
	if (!source) {
		throw new Error("No handoff history is linked to this session. Run /handoff from a persisted session first.");
	}
	return source;
}
