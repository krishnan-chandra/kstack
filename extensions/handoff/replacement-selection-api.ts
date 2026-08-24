import type { HandoffEffortLevel, HandoffModel } from "./model-selection.ts";

/** Minimal replacement-owned API needed to apply a handoff selection. */
export interface ReplacementSelectionApi {
	setModel(model: HandoffModel): Promise<boolean>;
	setThinkingLevel(level: HandoffEffortLevel): void;
}

// Pi may load an extension through a fresh module graph when it constructs the
// replacement runtime. Symbol.for provides one process-wide rendezvous without
// retaining the stale predecessor API in the command handler closure. Session
// IDs keep independent SDK runtimes from overwriting one another.
const REPLACEMENT_SELECTION_APIS = Symbol.for("kstack.handoff.replacement-selection-apis.v1");

function getRegistry(): Map<unknown, unknown> {
	const current: unknown = Reflect.get(globalThis, REPLACEMENT_SELECTION_APIS);
	if (current instanceof Map) return current;
	const created = new Map<unknown, unknown>();
	Reflect.set(globalThis, REPLACEMENT_SELECTION_APIS, created);
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
	const value: unknown = getRegistry().get(sessionId);
	if (typeof value !== "object" || value === null) return undefined;
	const setModel: unknown = Reflect.get(value, "setModel");
	const setThinkingLevel: unknown = Reflect.get(value, "setThinkingLevel");
	if (typeof setModel !== "function" || typeof setThinkingLevel !== "function") return undefined;
	return {
		async setModel(model) {
			const result: unknown = await Reflect.apply(setModel, value, [model]);
			return result === true;
		},
		setThinkingLevel(level) {
			Reflect.apply(setThinkingLevel, value, [level]);
		},
	};
}
