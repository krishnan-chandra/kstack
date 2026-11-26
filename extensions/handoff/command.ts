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

import type { ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { archiveDestination, getArchiveDbPath, getArchiveRoot } from "../session-archive/archive-files.ts";
import { archiveCurrentSession, preflightArchiveCurrentSession } from "../session-archive/archive-ops.ts";
import { loadKstackRoot } from "../shared/kstack-config.ts";
import { collectCatalogueNameAliases, collectKstackModelAliases } from "../shared/model-aliases.ts";
import { isRecord } from "../shared/narrow.ts";
import {
	claimSessionTransition,
	consumeSessionTransition,
	parseToolTokenArg,
	releaseSessionTransition,
} from "../shared/session-transition.ts";
import { extractSlug } from "../shared/slug.ts";
import { buildReferenceHandoffPrompt, DEFAULT_HANDOFF_GOAL, formatHistoryReference } from "./handoff-context.ts";
import {
	availableHistoryTools,
	describeHistoryAccess,
	type HistoryAccess,
	selectHistoryAccess,
} from "./history-access.ts";
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
	resolveModelReferenceWithSource,
} from "./model-selection.ts";
import { getReplacementSelectionApi, type ReplacementSelectionApi } from "./replacement-selection-api.ts";

type HandoffApi = {
	getThinkingLevel(): string;
	getAllTools(): readonly { name: string }[];
	getActiveTools(): readonly string[];
};

interface HandoffSessionResult {
	cancelled: boolean;
}

interface HandoffModelSelection {
	targetModel: HandoffModel | undefined;
	requestedEffort: HandoffEffortLevel | undefined;
}

interface PendingToolHandoff {
	token: string;
	sessionId: string;
	goal: string;
	archive: boolean;
	modelSelection: HandoffModelSelection;
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
type HandoffPreflightContext = Pick<
	ExtensionContext,
	"cwd" | "model" | "thinkingLevel" | "modelRegistry" | "scopedModels" | "sessionManager" | "ui" | "hasUI"
>;

export function createHandoffHandler(
	api: HandoffApi,
	deps: {
		preflightHistory?: (source: HandoffSource) => HandoffHistoryPreflight;
		getReplacementApi?: (sessionId: string) => ReplacementSelectionApi | undefined;
		consumeToolRequest?: (sessionId: string, token: string) => PendingToolHandoff | undefined;
	} = {},
) {
	const preflightHistory = deps.preflightHistory ?? preflightHandoffHistory;
	const getReplacementApi = deps.getReplacementApi ?? getReplacementSelectionApi;
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const toolToken = parseToolTokenArg(args);
		const toolRequest =
			toolToken !== undefined ? deps.consumeToolRequest?.(ctx.sessionManager.getSessionId(), toolToken) : undefined;
		if (toolRequest) {
			await executeHandoff(api, ctx, {
				goal: toolRequest.goal,
				archive: toolRequest.archive,
				modelSelection: toolRequest.modelSelection,
				interactiveEditor: false,
				preflightHistory,
				getReplacementApi,
			});
			return;
		}

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
		const modelResolution = resolveHandoffModelSelection(ctx, parsed.modelRef);
		if (!modelResolution.ok) {
			ctx.ui.notify(modelResolution.error, "error");
			return;
		}

		await executeHandoff(api, ctx, {
			goal,
			archive: parsed.archive,
			modelSelection: modelResolution.selection,
			interactiveEditor: true,
			preflightHistory,
			getReplacementApi,
		});
	};
}

async function executeHandoff(
	api: HandoffApi,
	ctx: ExtensionCommandContext,
	input: {
		goal: string;
		archive: boolean;
		modelSelection: HandoffModelSelection;
		interactiveEditor: boolean;
		preflightHistory: (source: HandoffSource) => HandoffHistoryPreflight;
		getReplacementApi: (sessionId: string) => ReplacementSelectionApi | undefined;
	},
): Promise<void> {
	await ctx.waitForIdle();

	const sourceResult = prepareHandoffSource(ctx, input.archive, input.preflightHistory);
	if (!sourceResult.ok) {
		ctx.ui.notify(sourceResult.error, "error");
		return;
	}
	const source = sourceResult.source;

	const access = selectHistoryAccess(availableHistoryTools(api), transcriptPath(ctx, input.archive, source));
	const { notice } = describeHistoryAccess(access);
	if (notice) ctx.ui.notify(notice.message, notice.level);
	if (access.kind === "unavailable") return;

	const historyRef = buildHandoffHistoryRef(input.archive, source, access);
	const draft = buildReferenceHandoffPrompt(input.goal, historyRef, access);
	const edited = input.interactiveEditor ? await promptHandoffEditor(ctx, draft) : draft;
	if (edited === undefined) return;

	const plan = buildHandoffPlan({
		api,
		ctx,
		edited,
		goal: input.goal,
		historyRef,
		source,
		...input.modelSelection,
	});
	const sessionOptions = buildHandoffSessionOptions(plan, input.getReplacementApi);

	const result = input.archive
		? await startArchivedHandoff(ctx, plan, sessionOptions)
		: await startDirectHandoff(ctx, source, edited, sessionOptions, input.preflightHistory);
	if (result === undefined) return;

	if (result.cancelled) ctx.ui.notify("New session cancelled", "info");
}

function resolveHandoffModelSelection(
	ctx: Pick<HandoffPreflightContext, "scopedModels" | "modelRegistry">,
	modelRef: string | undefined,
	explicitEffort?: HandoffEffortLevel,
): { ok: true; selection: HandoffModelSelection } | { ok: false; error: string } {
	if (modelRef === undefined) {
		return { ok: true, selection: { targetModel: undefined, requestedEffort: explicitEffort } };
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
	const resolution = resolveModelReferenceWithSource(catalogue, modelRef, aliases);
	if (resolution.status === "not-found") {
		const hint = scopedActive
			? " Model scoping is active, so only scoped models are accepted (see /scoped-models)."
			: " Use provider/model-id, a kstack.json model label, or a model display name (quote names with spaces), optionally with :<effort>; see /model for available models.";
		return { ok: false, error: `Unknown model "${modelRef}".${hint}` };
	}
	if (resolution.status === "ambiguous") {
		const options = resolution.matches.slice(0, 8).map(formatModelRef).join(", ");
		return { ok: false, error: `Model "${modelRef}" is ambiguous. Matches: ${options}. Use provider/model-id.` };
	}
	if (resolution.effortSource === "suffix" && explicitEffort !== undefined && resolution.effort !== explicitEffort) {
		return {
			ok: false,
			error: `Conflicting effort levels: model "${modelRef}" specifies "${resolution.effort}" while effort is "${explicitEffort}".`,
		};
	}
	return {
		ok: true,
		selection: {
			targetModel: resolution.model,
			requestedEffort: explicitEffort ?? resolution.effort,
		},
	};
}

function prepareHandoffSource(
	ctx: Pick<HandoffPreflightContext, "sessionManager" | "cwd">,
	archive: boolean,
	preflightHistory: (source: HandoffSource) => HandoffHistoryPreflight,
): { ok: true; source: HandoffSource } | { ok: false; error: string } {
	const oldFile = ctx.sessionManager.getSessionFile();
	if (oldFile === undefined) {
		return {
			ok: false,
			error: "handoff requires a persisted session and is unavailable with --no-session",
		};
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
			return { ok: false, error: `Cannot create a durable handoff: ${preflight.reason}` };
		}
	}
	return { ok: true, source };
}

/** The transcript file the replacement reads without handoff tools; `--archive` moves it to a deterministic path. */
function transcriptPath(
	ctx: Pick<HandoffPreflightContext, "sessionManager">,
	archive: boolean,
	source: HandoffSource,
): string {
	if (!archive) return source.sessionFile;
	return archiveDestination(getArchiveRoot(), source.sessionId, ctx.sessionManager.getHeader()?.timestamp ?? "");
}

function buildHandoffHistoryRef(archive: boolean, source: HandoffSource, access: HistoryAccess): string {
	const baseHistoryRef = formatHistoryReference(source.sessionFile, source.sessionId, source.cwd, access);
	if (!archive) return baseHistoryRef;
	return `${baseHistoryRef}\n${describeHistoryAccess(access).archivedStorage}`;
}

async function promptHandoffEditor(ctx: ExtensionCommandContext, draft: string): Promise<string | undefined> {
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
		replacementSessionName: extractSlug(editedGoal || input.goal, "development-task"),
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

export function createHandoffToolController(
	api: HandoffApi,
	deps: {
		sendUserMessage: (content: string, options: { expandPromptTemplates: boolean }) => void;
		preflightHistory?: (source: HandoffSource) => HandoffHistoryPreflight;
		preflightArchive?: typeof preflightArchiveCurrentSession;
		claimTransition?: (sessionId: string) => string | undefined;
		consumeTransition?: (sessionId: string, token: string) => boolean;
		releaseTransition?: (sessionId: string, token?: string) => void;
	},
) {
	const preflightHistory = deps.preflightHistory ?? preflightHandoffHistory;
	const preflightArchive = deps.preflightArchive ?? preflightArchiveCurrentSession;
	const claimTransition = deps.claimTransition ?? ((sessionId: string) => claimSessionTransition(sessionId, "handoff"));
	const consumeTransition =
		deps.consumeTransition ??
		((sessionId: string, token: string) => consumeSessionTransition(sessionId, "handoff", token));
	const releaseTransition = deps.releaseTransition ?? releaseSessionTransition;

	let pending: PendingToolHandoff | undefined;
	const claimedRequests = new Map<string, PendingToolHandoff>();

	const execute = async (
		_toolCallId: string,
		params: { goal?: string; model?: string; effort?: HandoffEffortLevel; archive?: boolean },
		_signal: AbortSignal | undefined,
		_onUpdate: BoundaryValue,
		ctx: Pick<
			HandoffPreflightContext,
			"cwd" | "model" | "thinkingLevel" | "modelRegistry" | "scopedModels" | "sessionManager"
		>,
	) => {
		if (params.effort !== undefined && !isHandoffEffortLevel(params.effort)) {
			throw new Error(`Unsupported effort level "${String(params.effort)}".`);
		}
		const modelResolution = resolveHandoffModelSelection(ctx, params.model, params.effort);
		if (!modelResolution.ok) {
			throw new Error(modelResolution.error);
		}

		const archive = params.archive === true;
		const goal = params.goal?.trim() || DEFAULT_HANDOFF_GOAL;

		const sourceResult = prepareHandoffSource(ctx, archive, preflightHistory);
		if (!sourceResult.ok) {
			throw new Error(sourceResult.error);
		}
		const source = sourceResult.source;

		if (archive) {
			const archiveCheck = preflightArchive({
				sourcePath: source.sessionFile,
				sessionId: source.sessionId,
				sessionDir: ctx.sessionManager.getSessionDir(),
				archiveRoot: getArchiveRoot(),
			});
			if (!archiveCheck.ok) {
				throw new Error(archiveCheck.message);
			}
		}

		const access = selectHistoryAccess(availableHistoryTools(api), transcriptPath(ctx, archive, source));
		const { notice } = describeHistoryAccess(access);
		if (access.kind === "unavailable") {
			throw new Error(notice?.message ?? "Cannot hand off: no tool in this session can read the previous session.");
		}

		const token = claimTransition(source.sessionId);
		if (!token) {
			throw new Error("A session replacement or archive is already scheduled for when this turn settles.");
		}

		pending = {
			token,
			sessionId: source.sessionId,
			goal,
			archive,
			modelSelection: modelResolution.selection,
		};

		const selectedModel = modelResolution.selection.targetModel;
		const selectedEffort = modelResolution.selection.requestedEffort;
		const summaryParts = [
			`Scheduled handoff from session ${source.sessionId}`,
			archive ? "with archiving" : "without archiving",
		];
		if (selectedModel || selectedEffort) {
			const targetLabel = selectedModel ? formatModelEffort(selectedModel, selectedEffort) : `effort:${selectedEffort}`;
			summaryParts.push(`target ${targetLabel}`);
		}
		const warningLine = notice?.level === "warning" ? `\nWarning: ${notice.message}` : "";
		return {
			content: [
				{
					type: "text" as const,
					text: `${summaryParts.join(" ")}. Pi will replace this session and start the continuation prompt once this turn settles.${warningLine}`,
				},
			],
			details: {
				scheduled: true,
				sessionId: source.sessionId,
				archive,
				goal,
				model: selectedModel ? formatModelRef(selectedModel) : undefined,
				effort: selectedEffort,
			},
			terminate: true,
		};
	};

	const onAgentSettled = (event: { aborted?: boolean }, ctx: Pick<ExtensionContext, "sessionManager">): void => {
		if (!pending) return;
		const current = pending;
		pending = undefined;
		if (event.aborted || current.sessionId !== ctx.sessionManager.getSessionId()) {
			releaseTransition(current.sessionId, current.token);
			return;
		}
		claimedRequests.set(current.token, current);
		try {
			deps.sendUserMessage(`/handoff --tool-token=${current.token}`, { expandPromptTemplates: true });
		} catch (err) {
			claimedRequests.delete(current.token);
			releaseTransition(current.sessionId, current.token);
			throw err;
		}
	};

	const onSessionShutdown = (_event: BoundaryValue, ctx: Pick<ExtensionContext, "sessionManager">): void => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (pending && pending.sessionId === sessionId) {
			releaseTransition(sessionId, pending.token);
			pending = undefined;
		}
		for (const [token, request] of claimedRequests) {
			if (request.sessionId !== sessionId) continue;
			claimedRequests.delete(token);
			releaseTransition(sessionId, token);
		}
	};

	const consumeToolRequest = (sessionId: string, token: string): PendingToolHandoff | undefined => {
		const request = claimedRequests.get(token);
		if (!request || request.sessionId !== sessionId) return undefined;
		claimedRequests.delete(token);
		if (!consumeTransition(sessionId, token)) return undefined;
		return request;
	};

	return { execute, onAgentSettled, onSessionShutdown, consumeToolRequest };
}
