/**
 * Process-wide rendezvous for steering the model and effort of a replacement
 * session.
 *
 * `ctx.newSession()` builds a brand-new runtime from Pi's configured defaults
 * (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`), so a command
 * that replaces a session — `/handoff`, `/session-archive`, `/sessions` — must
 * apply its selection inside `withSession`, after Pi has created that runtime.
 * Everything captured before the replacement is stale, including the
 * predecessor's `pi` object, so the live API is published by the replacement
 * runtime's own extension factory through this registry.
 *
 * Pi re-runs extension factories per runtime, sometimes through an isolated
 * module graph. `Symbol.for` provides one process-wide rendezvous without
 * retaining a stale API in a command-handler closure, and session IDs keep
 * independent SDK runtimes from overwriting one another.
 */
import type { ModelThinkingLevel } from "./kstack-config.ts";
import { type BoundaryValue, isFunction, isObject } from "./validation.ts";

/** Minimal structural view of a pi-ai Model, enough to resolve and set it. */
export interface ReplacementModelRef {
	provider: string;
	id: string;
	name?: string;
}

/** Minimal replacement-owned API needed to apply a model and effort selection. */
export interface ReplacementSelectionApi {
	setModel(model: ReplacementModelRef): Promise<boolean>;
	setThinkingLevel(level: ModelThinkingLevel): void;
}

// The key string is unchanged from the handoff-only module that introduced the
// rendezvous, so a predecessor module graph and its replacement still meet.
const REPLACEMENT_SELECTION_APIS = Symbol.for("kstack.handoff.replacement-selection-apis.v1");

function getRegistry(): Map<BoundaryValue, BoundaryValue> {
	const current: BoundaryValue = Object.getOwnPropertyDescriptor(globalThis, REPLACEMENT_SELECTION_APIS)?.value;
	if (current instanceof Map) return current;
	const created = new Map<BoundaryValue, BoundaryValue>();
	Object.defineProperty(globalThis, REPLACEMENT_SELECTION_APIS, { configurable: true, value: created });
	return created;
}

/** Publish the live API owned by one started Pi session runtime. */
export function bindReplacementSelectionApi(sessionId: string, api: ReplacementSelectionApi): void {
	getRegistry().set(sessionId, api);
}

/** Remove a session's API without deleting a newer replacement binding. */
export function unbindReplacementSelectionApi(sessionId: string, api: ReplacementSelectionApi): void {
	const registry = getRegistry();
	if (registry.get(sessionId) === api) registry.delete(sessionId);
}

/** Read one session's published API, validating the process-global boundary. */
export function getReplacementSelectionApi(sessionId: string): ReplacementSelectionApi | undefined {
	const value: BoundaryValue = getRegistry().get(sessionId);
	if (!isObject(value) || value === null) return undefined;
	const setModel: BoundaryValue = Object.getOwnPropertyDescriptor(value, "setModel")?.value;
	const setThinkingLevel: BoundaryValue = Object.getOwnPropertyDescriptor(value, "setThinkingLevel")?.value;
	if (!isFunction(setModel) || !isFunction(setThinkingLevel)) return undefined;
	return {
		async setModel(model) {
			const result: BoundaryValue = await setModel.call(value, model);
			return result === true;
		},
		setThinkingLevel(level) {
			setThinkingLevel.call(value, level);
		},
	};
}
