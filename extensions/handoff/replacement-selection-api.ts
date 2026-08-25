import { type BoundaryValue, isFunction, isObject } from "../shared/validation.ts";
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
