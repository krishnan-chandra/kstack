/**
 * Carry the current model and effort into the session that replaces an
 * archived one.
 *
 * `ctx.newSession()` builds a fresh runtime from Pi's configured defaults
 * (`defaultProvider`, `defaultModel`, and `defaultThinkingLevel` in
 * `$PI_CODING_AGENT_DIR/settings.json`), so archiving a session would
 * otherwise move the user to a different model. The selection is applied
 * inside `withSession`, after Pi created the replacement runtime: the
 * predecessor's `pi` and contexts are stale by then, so the live API comes
 * from the process-wide rendezvous in shared/replacement-selection-api.ts.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "../shared/kstack-config.ts";
import { getReplacementSelectionApi, type ReplacementModelRef } from "../shared/replacement-selection-api.ts";
import type { FreshSessionHandle } from "./archive-ops.ts";

/** Pi does not re-export the replacement context type; derive it from newSession. */
type ReplacedSessionContext = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>
>[0];

/** Plain model and effort values captured before the session replacement. */
interface CarriedSelection {
	model?: ReplacementModelRef;
	effort?: ModelThinkingLevel;
}

/** The session state a carried selection is read from. */
interface CarriedSelectionSource {
	model?: ReplacementModelRef;
	thinkingLevel?: ModelThinkingLevel;
}

/** Read the model and effort to restore, or undefined when the session has neither. */
export function readCarriedSelection(ctx: CarriedSelectionSource): CarriedSelection | undefined {
	const model: ReplacementModelRef | undefined = ctx.model
		? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name }
		: undefined;
	const effort = ctx.thinkingLevel;
	if (!model && !effort) return undefined;
	return { model, effort };
}

/**
 * Start a new session that keeps the carried model and effort, then run
 * `continueInFresh` on it. A selection that cannot be applied is reported in
 * the replacement session and never blocks the archive itself.
 */
export function startNewSessionCarryingSelection(
	ctx: ExtensionCommandContext,
	carried: CarriedSelection | undefined,
	continueInFresh: (fresh: FreshSessionHandle) => Promise<void>,
): Promise<{ cancelled: boolean }> {
	// Deliberately no parentSession: the archive destination does not exist
	// yet, and SQLite preserves the archive relationship.
	return ctx.newSession({
		withSession: async (fresh) => {
			const failure = await applyCarriedSelection(fresh, carried);
			if (failure !== undefined) {
				fresh.ui.notify(
					`Session replaced, but the previous model and effort could not be restored: ${failure}. ` +
						"The replacement session is using the configured default.",
					"warning",
				);
			}
			await continueInFresh({ notify: (message, level) => fresh.ui.notify(message, level) });
		},
	});
}

/** Apply the carried selection to a live replacement session; returns a failure message. */
async function applyCarriedSelection(
	fresh: ReplacedSessionContext,
	carried: CarriedSelection | undefined,
): Promise<string | undefined> {
	if (!carried?.model && !carried?.effort) return undefined;

	const api = getReplacementSelectionApi(fresh.sessionManager.getSessionId());
	if (!api) return "the replacement session API is unavailable";

	let failure: string | undefined;
	const target = carried.model;
	if (target && !isActiveModel(fresh, target)) {
		try {
			const switched = await api.setModel(target);
			if (!switched) failure = `no credentials for ${target.provider}/${target.id}`;
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		}
	}
	if (carried.effort) {
		try {
			api.setThinkingLevel(carried.effort);
		} catch (err) {
			failure ??= err instanceof Error ? err.message : String(err);
		}
	}
	return failure;
}

/** True when the replacement session already runs the carried model. */
function isActiveModel(fresh: ReplacedSessionContext, target: ReplacementModelRef): boolean {
	if (!fresh.model) return false;
	return fresh.model.provider === target.provider && fresh.model.id === target.id;
}
