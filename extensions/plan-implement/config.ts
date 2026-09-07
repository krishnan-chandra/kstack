import { type BoundaryValue, isObject, type JsonObject } from "../shared/validation.ts";
/** Unified kstack.json configuration and role-model resolution. */

import { validateBoundedNumber } from "../shared/config-validate.ts";
import { resolveModelRef } from "../shared/herdr/resolve-model.ts";
import {
	isThinkingLevel,
	loadKstackSection,
	loadValidatedSection,
	type ConfigLoad as SharedConfigLoad,
	THINKING_LEVELS,
	validatePlanAdversaryConfig,
} from "../shared/kstack-config.ts";
import { collectKstackModelAliases } from "../shared/model-aliases.ts";
import { splitModelRef, validateModelSpecFields } from "../shared/model-spec.ts";
import {
	LIMITS,
	type ModelThinkingLevel,
	type PlanImplementConfig,
	type ResolvedRoles,
	type RoleSpec,
} from "./types.ts";

export { modelCliId } from "../shared/model-spec.ts";

const HIGH_THINKING = new Set<ModelThinkingLevel>(["high", "xhigh", "max"]);

export const DEFAULT_PLANNERS: readonly RoleSpec[] = [
	{ model: "openai/gpt-5.6-sol", thinking: "high" },
	{ model: "openrouter/anthropic/claude-opus-4.6", thinking: "high" },
	{ model: "anthropic/claude-fable-5", thinking: "high" },
];

export const DEFAULT_IMPLEMENTERS: readonly RoleSpec[] = [
	{ model: "openai/gpt-5.6-terra", thinking: "medium" },
	{ model: "openrouter/z-ai/glm-5.2", thinking: "high" },
	{ model: "openrouter/deepseek/deepseek-v4-flash", thinking: "high" },
	{ model: "openrouter/moonshotai/kimi-k3", thinking: "medium" },
];

type ConfigLoad = SharedConfigLoad<PlanImplementConfig>;

function validateRole(
	raw: BoundaryValue,
	role: "planner" | "implementer",
): { ok: true; spec: RoleSpec } | { ok: false; error: string } {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) {
		return { ok: false, error: `"${role}" must be {"model":"provider/model","thinking"?}.` };
	}
	const value =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	const fields = validateModelSpecFields(value, {
		requireLabel: false,
		errors: {
			label: () => `"${role}" does not use a label.`,
			model: () => `"${role}.model" must be a provider/model id.`,
			thinking: () => `"${role}.thinking" must be one of ${THINKING_LEVELS.join(", ")}.`,
		},
	});
	if (!fields.ok) return fields;
	const thinking: ModelThinkingLevel | undefined = fields.thinking ?? (role === "planner" ? "high" : undefined);
	if (role === "planner" && (!thinking || !HIGH_THINKING.has(thinking))) {
		return { ok: false, error: '"planner.thinking" must be high, xhigh, or max.' };
	}
	return { ok: true, spec: { model: fields.model, thinking } };
}

export function validateConfig(
	raw: BoundaryValue,
): { ok: true; config: PlanImplementConfig } | { ok: false; error: string } {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "plan-implement config must be a JSON object." };
	}
	const value =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	const planner = validateRole(value.planner, "planner");
	if (!planner.ok) return planner;
	const implementer = validateRole(value.implementer, "implementer");
	if (!implementer.ok) return implementer;
	if (planner.spec.model === implementer.spec.model) {
		return { ok: false, error: "Planner and implementer must use different models." };
	}
	let timeoutMinutes: number = LIMITS.defaultTimeoutMinutes;
	if (value.timeoutMinutes !== undefined) {
		if (
			!validateBoundedNumber(value.timeoutMinutes, {
				integer: true,
				min: LIMITS.minTimeoutMinutes,
				max: LIMITS.maxTimeoutMinutes,
			})
		) {
			return {
				ok: false,
				error: `"timeoutMinutes" must be an integer from ${LIMITS.minTimeoutMinutes} to ${LIMITS.maxTimeoutMinutes}.`,
			};
		}
		timeoutMinutes = value.timeoutMinutes;
	}
	return { ok: true, config: { planner: planner.spec, implementer: implementer.spec, timeoutMinutes } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	return loadValidatedSection("plan-implement", validateConfig, env);
}

interface ResolveDeps {
	available: (provider: string, modelId: string) => boolean;
}

interface ResolvedAdversary {
	model: string;
	maxRounds: number;
	timeoutMinutes: number;
}

type AdversaryResolution = { ok: true; adversary?: ResolvedAdversary; notice?: string } | { ok: false; error: string };

function isAvailable(spec: RoleSpec, deps: ResolveDeps): boolean {
	const { provider, modelId } = splitModelRef(spec.model);
	return deps.available(provider, modelId);
}

export function resolveRoles(
	config: PlanImplementConfig | null,
	deps: ResolveDeps,
): { ok: true; roles: ResolvedRoles } | { ok: false; error: string } {
	if (config) {
		const missing = [config.planner, config.implementer].filter((spec) => !isAvailable(spec, deps));
		if (missing.length > 0) {
			return {
				ok: false,
				error: `Configured plan-implement models are unavailable or unauthenticated: ${missing.map((x) => x.model).join(", ")}.`,
			};
		}
		return { ok: true, roles: { ...config, source: "config" } };
	}
	const planner = DEFAULT_PLANNERS.find((spec) => isAvailable(spec, deps));
	if (!planner) {
		return {
			ok: false,
			error: `No high-reason planner model is available. Tried: ${DEFAULT_PLANNERS.map((x) => x.model).join(", ")}.`,
		};
	}
	const implementer = DEFAULT_IMPLEMENTERS.find((spec) => isAvailable(spec, deps) && spec.model !== planner.model);
	if (!implementer) {
		return {
			ok: false,
			error: `No distinct implementer model is available. Tried: ${DEFAULT_IMPLEMENTERS.map((x) => x.model).join(", ")}.`,
		};
	}
	return {
		ok: true,
		roles: {
			planner: { ...planner },
			implementer: { ...implementer },
			timeoutMinutes: LIMITS.defaultTimeoutMinutes,
			source: "default",
		},
	};
}

function modelWithoutThinking(ref: string): string {
	const separator = ref.lastIndexOf(":");
	if (separator < 0 || !isThinkingLevel(ref.slice(separator + 1))) return ref;
	return ref.slice(0, separator);
}

/** Resolve the optional adversary through the shared validator and kstack.json aliases. */
export function resolveAdversary(
	enabled: boolean,
	plannerModel: string,
	deps: ResolveDeps,
	env: NodeJS.ProcessEnv = process.env,
): AdversaryResolution {
	const loaded = loadKstackSection("plan-adversary", env);
	if (loaded.status === "invalid") return { ok: false, error: `Invalid ${loaded.path}: ${loaded.error}` };
	if (!enabled) {
		if (loaded.status === "missing") {
			return { ok: true, notice: "--no-adversary has no effect because plan-adversary is not configured." };
		}
		return { ok: true };
	}
	if (loaded.status === "missing") return { ok: true };
	const validated = validatePlanAdversaryConfig(loaded.value);
	if (!validated.ok) return { ok: false, error: `Invalid ${loaded.path}: ${validated.error}` };
	const resolved = resolveModelRef({
		configured: validated.config.adversary,
		aliases: collectKstackModelAliases(loaded.root),
		section: "plan-adversary",
		key: "adversary",
	});
	if (!resolved.ok) return resolved;
	const model = modelWithoutThinking(resolved.ref);
	if (model === plannerModel) return { ok: false, error: "The adversary model must differ from the planner model." };
	const { provider, modelId } = splitModelRef(model);
	if (!deps.available(provider, modelId)) {
		return { ok: false, error: `Configured plan-adversary model is unavailable or unauthenticated: ${model}.` };
	}
	return {
		ok: true,
		adversary: {
			model: resolved.ref,
			maxRounds: validated.config.maxRounds,
			timeoutMinutes: validated.config.timeoutMinutes,
		},
	};
}

/**
 * Resolve only the implementer role, for `--fast` mode which has no planner.
 * Uses the configured `implementer` when present and authenticated, otherwise
 * the first authenticated default implementer. The planner/distinctness
 * constraint does not apply.
 */
export function resolveImplementerOnly(
	config: PlanImplementConfig | null,
	deps: ResolveDeps,
): { ok: true; implementer: RoleSpec } | { ok: false; error: string } {
	const configured = config?.implementer;
	if (configured) {
		if (!isAvailable(configured, deps)) {
			return {
				ok: false,
				error: `Configured plan-implement implementer is unavailable or unauthenticated: ${configured.model}.`,
			};
		}
		return { ok: true, implementer: configured };
	}
	const implementer = DEFAULT_IMPLEMENTERS.find((spec) => isAvailable(spec, deps));
	if (!implementer) {
		return {
			ok: false,
			error: `No fast implementer model is available. Tried: ${DEFAULT_IMPLEMENTERS.map((x) => x.model).join(", ")}.`,
		};
	}
	return { ok: true, implementer };
}
