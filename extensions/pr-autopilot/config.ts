/**
 * pr-autopilot configuration: discovery, validation, and tiny-model resolution.
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
 * The autopilot is tiny-model-only by construction: the validator rejects any
 * thinking level above "low" and the resolver only considers the configured
 * tiny set. When no config file exists the built-in DEFAULT_TINY_MODELS
 * (GPT-5.6 Luna, GLM 5.2, DeepSeek V4 Flash) are used.
 */

import { validateBoundedNumber } from "../shared/config-validate.ts";
import {
	loadValidatedSection,
	type ModelThinkingLevel,
	type ConfigLoad as SharedConfigLoad,
	THINKING_LEVELS,
} from "../shared/kstack-config.ts";
import { splitModelRef, validateModelSpecFields } from "../shared/model-spec.ts";
import type { AutopilotModelSpec, ResolvedAutopilotConfig, TinyThinkingLevel } from "./types.ts";

export { modelCliId } from "../shared/model-spec.ts";

const TINY_THINKING = ["off", "minimal", "low"] as const satisfies readonly TinyThinkingLevel[];

function isTinyThinkingLevel(value: ModelThinkingLevel): value is TinyThinkingLevel {
	return TINY_THINKING.some((allowed) => allowed === value);
}

export type ConfigLoad = SharedConfigLoad<ResolvedAutopilotConfig>;

/**
 * Built-in tiny model set, used when no pr-autopilot config section exists.
 * These are the only models the autopilot may spawn children with. Each run
 * picks one at random. They are small, fast, and cheap enough for repeated
 * triage loops.
 */
export const DEFAULT_TINY_MODELS: readonly AutopilotModelSpec[] = [
	{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
	{ label: "glm", model: "openrouter/z-ai/glm-5.2", thinking: "low" },
	{ label: "deepseek", model: "openrouter/deepseek/deepseek-v4-flash", thinking: "low" },
] as const;

/**
 * Validate a single model spec. Enforces the tiny-model invariant: thinking
 * must be at most "low" (or absent, which defaults to "low").
 */
function validateModelSpec(
	raw: unknown,
	index: number,
): { ok: true; spec: AutopilotModelSpec } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: `Model entry ${index} must be an object {label, model, thinking?}.` };
	}
	const value = raw as Record<string, unknown>;
	const fields = validateModelSpecFields(value, {
		requireLabel: true,
		allowedThinking: TINY_THINKING,
		errors: {
			label: () => `Model entry ${index}: "label" must be 1–16 chars of [A-Za-z0-9_-].`,
			model: () => `Model entry ${index} (${value.label}): "model" must be "provider/model".`,
			thinking: (thinking) =>
				typeof thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(thinking)
					? `Model entry ${index} (${value.label}): "thinking" must be "off", "minimal", or "low" — the autopilot is tiny-model-only.`
					: `Model entry ${index} (${value.label}): "thinking" must be one of ${THINKING_LEVELS.join(", ")}.`,
		},
	});
	if (!fields.ok) return fields;
	const label = fields.label;
	if (!label) return { ok: false, error: `Model entry ${index}: "label" must be 1–16 chars of [A-Za-z0-9_-].` };
	const thinking = fields.thinking ?? "low";
	if (!isTinyThinkingLevel(thinking)) {
		return {
			ok: false,
			error: `Model entry ${index} (${label}): "thinking" must be "off", "minimal", or "low" — the autopilot is tiny-model-only.`,
		};
	}
	return { ok: true, spec: { label, model: fields.model, thinking } };
}

interface ValidateConfigResult {
	ok: true;
	config: Omit<ResolvedAutopilotConfig, "source" | "warnings">;
}
interface ValidateConfigError {
	ok: false;
	error: string;
}

export function validateConfig(raw: unknown): ValidateConfigResult | ValidateConfigError {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "pr-autopilot config must be a JSON object." };
	}
	const obj = raw as Record<string, unknown>;

	if (!Array.isArray(obj.models)) {
		return { ok: false, error: '"models" must be an array of {label, model, thinking?}.' };
	}
	if (obj.models.length < 2) {
		return {
			ok: false,
			error: '"models" must contain at least 2 tiny model entries so each run can pick one at random.',
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
		// Tiny-model invariant: each model must differ.
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

export interface ResolveDeps {
	available: (provider: string, modelId: string) => boolean;
}

/**
 * Resolve the tiny model set against the Pi model registry. With a config file
 * every listed model must be available (hard error otherwise). Without one,
 * the built-in DEFAULT_TINY_MODELS are filtered to what's available; the
 * remaining set is returned (at least 2 expected).
 */
export function resolveModels(
	config: ConfigLoad,
	deps: ResolveDeps,
): { ok: true; config: ResolvedAutopilotConfig } | { ok: false; error: string } {
	const warnings: string[] = [];

	if (config.status === "invalid") {
		return { ok: false, error: `Invalid ${config.path}: ${config.error}` };
	}

	if (config.status === "loaded") {
		const unavailable: string[] = [];
		for (const m of config.config.models) {
			const { provider, modelId } = splitModelRef(m.model);
			if (!deps.available(provider, modelId)) {
				unavailable.push(`${m.label}: ${m.model}`);
			}
		}
		if (unavailable.length > 0) {
			return {
				ok: false,
				error:
					"Configured pr-autopilot models are unavailable or unauthenticated:\n  " +
					unavailable.join("\n  ") +
					"\nFix the pr-autopilot section in kstack.json or authenticate the providers.",
			};
		}
		return {
			ok: true,
			config: { ...config.config, source: "config", warnings: [...config.config.warnings, ...warnings] },
		};
	}

	// No config: fall back to the built-in tiny model defaults, filtered.
	const available: AutopilotModelSpec[] = [];
	const skipped: string[] = [];
	for (const m of DEFAULT_TINY_MODELS) {
		const { provider, modelId } = splitModelRef(m.model);
		if (deps.available(provider, modelId)) {
			available.push({ ...m });
		} else {
			skipped.push(m.model);
		}
	}
	if (skipped.length > 0) {
		warnings.push(`Default tiny models unavailable, skipping: ${skipped.join(", ")}.`);
	}
	if (available.length < 2) {
		return {
			ok: false,
			error:
				"Fewer than 2 tiny models are available. Configure the pr-autopilot " +
				"section in kstack.json with at least 2 tiny-model entries (thinking ≤ low).",
		};
	}
	return {
		ok: true,
		config: {
			models: available,
			maxConcurrency: 3,
			timeoutMinutes: 5,
			maxRuntimeMinutes: 15,
			source: "default",
			warnings,
		},
	};
}
