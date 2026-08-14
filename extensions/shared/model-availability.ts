/** Model availability checks for child Pi processes started with --no-extensions. */

export interface ChildModelRegistry {
	find(provider: string, modelId: string): unknown | undefined;
	hasConfiguredAuth(model: unknown): boolean;
	getRegisteredProviderIds(): readonly string[];
}

/**
 * Parent extension registrations are intentionally absent from child agents.
 * Reject every provider touched by registerProvider(), even when it overrides
 * a built-in provider, because the child may otherwise see different models,
 * routing, or authentication than the parent validated.
 */
export function isChildModelAvailable(registry: ChildModelRegistry, provider: string, modelId: string): boolean {
	if (registry.getRegisteredProviderIds().includes(provider)) return false;
	const model = registry.find(provider, modelId);
	return model !== undefined && registry.hasConfiguredAuth(model);
}
