import { type BoundaryValue, isObject, type JsonObject } from "../shared/validation.ts";
/**
 * pr-autopilot configuration: discovery, validation, and model-pool resolution.
 *
 * Config lives in the `"pr-autopilot"` section of
 * `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`):
 *
 *   {
 *     "pr-autopilot": {
 *       "models": [
 *         { "label": "luna",     "model": "openai/gpt-5.6-luna", "thinking": "low" },
 *         { "label": "glm",       "model": "openrouter/z-ai/glm-5.2", "thinking": "low" },
 *         { "label": "deepseek", "model": "openrouter/deepseek/deepseek-v4-flash", "thinking": "low" }
 *       ],
 *       "maxConcurrency": 3,
 *       "timeoutMinutes": 5,
 *       "maxRuntimeMinutes": 15
 *     }
 *   }
 *
 * The autopilot uses only the configured model pool. Any supported thinking
 * level is accepted, and explicit model IDs are trusted so provider models can be used
 * before Pi's bundled catalog catches up. When no config file exists the
 * built-in DEFAULT_AUTOPILOT_MODELS (GPT-5.6 Luna, GLM 5.2, DeepSeek V4 Flash) are
 * used.
 */

import { validateBoundedNumber } from "../shared/config-validate.ts";
import { loadValidatedSection, type ConfigLoad as SharedConfigLoad, THINKING_LEVELS } from "../shared/kstack-config.ts";
import { validateModelSpecFields } from "../shared/model-spec.ts";
import type { AutopilotModelSpec, ResolvedAutopilotConfig } from "./types.ts";

export { modelCliId } from "../shared/model-spec.ts";

export type ConfigLoad = SharedConfigLoad<ResolvedAutopilotConfig>;

/**
 * Built-in model set, used when no pr-autopilot config section exists.
 * These are the only models the autopilot may spawn children with. Each run
 * picks one at random. They are small, fast, and cheap enough for repeated
 * triage loops.
 */
export const DEFAULT_AUTOPILOT_MODELS: readonly AutopilotModelSpec[] = [
	{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
	{ label: "glm", model: "openrouter/z-ai/glm-5.2", thinking: "low" },
	{ label: "deepseek", model: "openrouter/deepseek/deepseek-v4-flash", thinking: "low" },
] as const;

/** Validate one model spec, defaulting its thinking level to "low". */
function validateModelSpec(
	raw: BoundaryValue,
	index: number,
): { ok: true; spec: AutopilotModelSpec } | { ok: false; error: string } {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) {
		return { ok: false, error: `Model entry ${index} must be an object {label, model, thinking?}.` };
	}
	const value =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	const fields = validateModelSpecFields(value, {
		requireLabel: true,
		allowedThinking: THINKING_LEVELS,
		errors: {
			label: () => `Model entry ${index}: "label" must be 1–16 chars of [A-Za-z0-9_-].`,
			model: () => `Model entry ${index} (${value.label}): "model" must be "provider/model".`,
			thinking: () => `Model entry ${index} (${value.label}): "thinking" must be one of ${THINKING_LEVELS.join(", ")}.`,
		},
	});
	if (!fields.ok) return fields;
	const label = fields.label;
	if (!label) return { ok: false, error: `Model entry ${index}: "label" must be 1–16 chars of [A-Za-z0-9_-].` };
	return { ok: true, spec: { label, model: fields.model, thinking: fields.thinking ?? "low" } };
}

interface ValidateConfigResult {
	ok: true;
	config: Omit<ResolvedAutopilotConfig, "source" | "warnings">;
}
interface ValidateConfigError {
	ok: false;
	error: string;
}

export function validateConfig(raw: BoundaryValue): ValidateConfigResult | ValidateConfigError {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "pr-autopilot config must be a JSON object." };
	}
	const obj =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;

	if (!Array.isArray(obj.models)) {
		return { ok: false, error: '"models" must be an array of {label, model, thinking?}.' };
	}
	if (obj.models.length < 2) {
		return {
			ok: false,
			error: '"models" must contain at least 2 model entries so each run can pick one at random.',
		};
	}
	if (obj.models.length > 6) {
		return { ok: false, error: '"models" may contain at most 6 entries.' };
	}

	const labels = new Set<string>();
	const models: AutopilotModelSpec[] = [];
	for (let i = 0; i < obj.models.length; i++) {
		const result = validateModelSpec(obj.models[i], i);
		if (!result.ok) return result;
		if (labels.has(result.spec.label)) {
			return { ok: false, error: `Duplicate model label "${result.spec.label}".` };
		}
		// Each configured model must differ.
		if (models.some((m) => m.model === result.spec.model)) {
			return { ok: false, error: `Duplicate model "${result.spec.model}" (label "${result.spec.label}").` };
		}
		labels.add(result.spec.label);
		models.push(result.spec);
	}

	let maxConcurrency = 3;
	if (obj.maxConcurrency !== undefined) {
		if (!validateBoundedNumber(obj.maxConcurrency, { integer: true, min: 1, max: 5 })) {
			return { ok: false, error: `"maxConcurrency" must be an integer between 1 and 5.` };
		}
		maxConcurrency = obj.maxConcurrency;
	}

	let timeoutMinutes = 5;
	if (obj.timeoutMinutes !== undefined) {
		if (!validateBoundedNumber(obj.timeoutMinutes, { min: 1, max: 15 })) {
			return { ok: false, error: `"timeoutMinutes" must be a number between 1 and 15.` };
		}
		timeoutMinutes = obj.timeoutMinutes;
	}

	let maxRuntimeMinutes = 15;
	if (obj.maxRuntimeMinutes !== undefined) {
		if (!validateBoundedNumber(obj.maxRuntimeMinutes, { min: 2, max: 60 })) {
			return { ok: false, error: `"maxRuntimeMinutes" must be a number between 2 and 60.` };
		}
		maxRuntimeMinutes = obj.maxRuntimeMinutes;
	}

	if (maxRuntimeMinutes < timeoutMinutes) {
		return { ok: false, error: '"maxRuntimeMinutes" must be >= "timeoutMinutes".' };
	}

	return {
		ok: true,
		config: {
			models,
			maxConcurrency,
			timeoutMinutes,
			maxRuntimeMinutes,
		},
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	return loadValidatedSection(
		"pr-autopilot",
		(raw) => {
			const result = validateConfig(raw);
			return result.ok ? { ok: true, config: { ...result.config, source: "config", warnings: [] } } : result;
		},
		env,
	);
}

/** Resolve validated configured models or the complete built-in default set. */
export function resolveModels(
	config: ConfigLoad,
): { ok: true; config: ResolvedAutopilotConfig } | { ok: false; error: string } {
	if (config.status === "invalid") {
		return { ok: false, error: `Invalid ${config.path}: ${config.error}` };
	}
	if (config.status === "loaded") return { ok: true, config: config.config };
	return {
		ok: true,
		config: {
			models: DEFAULT_AUTOPILOT_MODELS.map((model) => ({ ...model })),
			maxConcurrency: 3,
			timeoutMinutes: 5,
			maxRuntimeMinutes: 15,
			source: "default",
			warnings: [],
		},
	};
}
