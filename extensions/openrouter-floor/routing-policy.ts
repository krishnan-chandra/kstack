import { type ConfigLoad, loadValidatedSection, MODEL_ID_RE } from "../shared/kstack-config.ts";
import { isRecord } from "../shared/narrow.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { type CurrentModel, hasVariant } from "./floor-rewrite.ts";

export type RoutingVariant = "floor" | "nitro" | "none";
type VariantSource = "model-suffix" | "session-override" | "config-model" | "config-default" | "built-in";
export interface RoutingConfig {
	default: RoutingVariant;
	models: ReadonlyMap<string, RoutingVariant>;
}
// Explicit suffixes can name variants outside the configurable vocabulary (e.g. :free).
export type ResolvedVariant =
	| { source: "model-suffix"; variant: string }
	| { source: Exclude<VariantSource, "model-suffix">; variant: RoutingVariant };

export const BUILT_IN_ROUTING: RoutingConfig = { default: "floor", models: new Map() };

export function isRoutingVariant(value: BoundaryValue): value is RoutingVariant {
	return value === "floor" || value === "nitro" || value === "none";
}

export function validateRoutingConfig(
	value: BoundaryValue,
): { ok: true; config: RoutingConfig } | { ok: false; error: string } {
	if (!isRecord(value)) return { ok: false, error: "openrouter-floor must be an object." };
	for (const key of Object.keys(value)) {
		if (key !== "default" && key !== "models") return { ok: false, error: `openrouter-floor.${key} is not supported.` };
	}
	const defaultVariant = value.default === undefined ? "floor" : value.default;
	if (!isRoutingVariant(defaultVariant))
		return { ok: false, error: "openrouter-floor.default must be floor, nitro, or none." };
	const models = new Map<string, RoutingVariant>();
	if (value.models !== undefined) {
		if (!isRecord(value.models)) return { ok: false, error: "openrouter-floor.models must be an object." };
		for (const [key, variant] of Object.entries(value.models)) {
			const id = key.slice("openrouter/".length);
			if (!key.startsWith("openrouter/") || !MODEL_ID_RE.test(key) || hasVariant(key)) {
				return {
					ok: false,
					error: `openrouter-floor.models[${JSON.stringify(key)}] must be an exact openrouter/<model-id> without a variant suffix.`,
				};
			}
			if (!isRoutingVariant(variant))
				return { ok: false, error: `openrouter-floor.models[${JSON.stringify(key)}] must be floor, nitro, or none.` };
			models.set(id, variant);
		}
	}
	return { ok: true, config: { default: defaultVariant, models } };
}

export function loadRoutingConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad<RoutingConfig> {
	return loadValidatedSection("openrouter-floor", validateRoutingConfig, env);
}

export function resolveVariant(input: {
	config: RoutingConfig;
	sessionOverride: RoutingVariant | undefined;
	model: CurrentModel | undefined;
}): ResolvedVariant | undefined {
	const { model, config, sessionOverride } = input;
	if (model === undefined || model.provider !== "openrouter") return undefined;
	if (hasVariant(model.id))
		return { variant: model.id.slice(model.id.indexOf(":", model.id.indexOf("/") + 1) + 1), source: "model-suffix" };
	if (sessionOverride !== undefined) return { variant: sessionOverride, source: "session-override" };
	const variant = config.models.get(model.id);
	if (variant !== undefined) return { variant, source: "config-model" };
	return { variant: config.default, source: config === BUILT_IN_ROUTING ? "built-in" : "config-default" };
}
