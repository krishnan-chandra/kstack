import type { BoundaryValue } from "./validation.ts";
/** Model availability checks for isolated child Pi processes. */

export interface ChildModelRegistry {
	find(provider: string, modelId: string): BoundaryValue | undefined;
	hasConfiguredAuth(model: BoundaryValue): boolean;
	getRegisteredProviderIds(): readonly string[];
}

/**
 * Reject every provider touched by registerProvider(), even when it overrides
 * a built-in provider. Children discover extensions independently, so the
 * parent cannot verify that a child composes the same models, routing, or
 * authentication it validated here.
 */
export function isChildModelAvailable(registry: ChildModelRegistry, provider: string, modelId: string): boolean {
	if (registry.getRegisteredProviderIds().includes(provider)) return false;
	const model = registry.find(provider, modelId);
	return model !== undefined && registry.hasConfiguredAuth(model);
}
