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
 *         { "label": "gemini",   "model": "openrouter/google/gemini-3.7-flash", "thinking": "low" },
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
 * (GPT-5.6 Luna, Gemini 3.7 Flash, DeepSeek V4 Flash) are used.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutopilotModelSpec, ResolvedAutopilotConfig } from "./types.ts";

const MODEL_ID_RE = /^[^/\s]+(\/[^/\s]+)+$/;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ConfigLoad =
	| { status: "loaded"; config: ResolvedAutopilotConfig; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return join(homedir(), ".pi", "agent");
}

export function getKstackPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "kstack.json");
}

/**
 * Built-in tiny model set, used when no pr-autopilot config section exists.
 * These are the only models the autopilot is ever allowed to spawn children
 * with — they are small, fast, and cheap enough for repeated triage loops.
 */
export const DEFAULT_TINY_MODELS: readonly AutopilotModelSpec[] = [
	{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
	{ label: "gemini", model: "openrouter/google/gemini-3.7-flash", thinking: "low" },
	{ label: "deepseek", model: "openrouter/deepseek/deepseek-v4-flash", thinking: "low" },
] as const;

/**
 * Validate a single model spec. Enforces the tiny-model invariant: thinking
 * must be at most "low" (or absent, which defaults to "low").
 */
function validateModelSpec(raw: unknown, index: number): { ok: true; spec: AutopilotModelSpec } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: `Model entry ${index} must be an object {label, model, thinking?}.` };
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.label !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(value.label)) {
		return { ok: false, error: `Model entry ${index}: "label" must be 1–16 chars of [A-Za-z0-9_-].` };
	}
	if (typeof value.model !== "string" || !MODEL_ID_RE.test(value.model)) {
		return { ok: false, error: `Model entry ${index} (${value.label}): "model" must be "provider/model".` };
	}
	if (value.thinking !== undefined) {
		if (typeof value.thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value.thinking)) {
			return { ok: false, error: `Model entry ${index} (${value.label}): "thinking" must be one of ${THINKING_LEVELS.join(", ")}.` };
		}
		// Tiny-model invariant: no thinking level above "low".
		const allowed = ["off", "minimal", "low"];
		if (!allowed.includes(value.thinking)) {
			return {
				ok: false,
				error: `Model entry ${index} (${value.label}): "thinking" must be "off", "minimal", or "low" — the autopilot is tiny-model-only.`,
			};
		}
	}
	return { ok: true, spec: { label: value.label, model: value.model, thinking: (value.thinking ?? "low") as string } };
}

export interface ValidateConfigResult {
	ok: true;
	config: Omit<ResolvedAutopilotConfig, "source" | "warnings">;
}
export interface ValidateConfigError {
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
		return { ok: false, error: '"models" must contain at least 2 tiny model entries for independent triage.' };
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

	let maxConcurrency;
	if (obj.maxConcurrency !== undefined) {
		if (typeof obj.maxConcurrency !== "number" || !Number.isInteger(obj.maxConcurrency) || obj.maxConcurrency < 1 || obj.maxConcurrency > 5) {
			return { ok: false, error: `"maxConcurrency" must be an integer between 1 and 5.` };
		}
		maxConcurrency = obj.maxConcurrency;
	} else {
		maxConcurrency = 3;
	}

	let timeoutMinutes;
	if (obj.timeoutMinutes !== undefined) {
		if (typeof obj.timeoutMinutes !== "number" || !Number.isFinite(obj.timeoutMinutes) || obj.timeoutMinutes < 1 || obj.timeoutMinutes > 15) {
			return { ok: false, error: `"timeoutMinutes" must be a number between 1 and 15.` };
		}
		timeoutMinutes = obj.timeoutMinutes;
	} else {
		timeoutMinutes = 5;
	}

	let maxRuntimeMinutes;
	if (obj.maxRuntimeMinutes !== undefined) {
		if (typeof obj.maxRuntimeMinutes !== "number" || !Number.isFinite(obj.maxRuntimeMinutes) || obj.maxRuntimeMinutes < 2 || obj.maxRuntimeMinutes > 60) {
			return { ok: false, error: `"maxRuntimeMinutes" must be a number between 2 and 60.` };
		}
		maxRuntimeMinutes = obj.maxRuntimeMinutes;
	} else {
		maxRuntimeMinutes = 15;
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
	const path = getKstackPath(env);
	if (!existsSync(path)) return { status: "missing", path };
	try {
		const root = JSON.parse(readFileSync(path, "utf8"));
		if (typeof root !== "object" || root === null || Array.isArray(root)) {
			return { status: "invalid", path, error: "kstack.json must be a JSON object." };
		}
		const rootObj = root as Record<string, unknown>;
		const section = rootObj["pr-autopilot"] ?? rootObj["pr-babysit"];
		if (section === undefined) return { status: "missing", path };
		const result = validateConfig(section);
		if (!result.ok) return { status: "invalid", path, error: result.error };
		const warnings =
			rootObj["pr-autopilot"] === undefined && rootObj["pr-babysit"] !== undefined
				? ['kstack.json still has "pr-babysit"; rename that section to "pr-autopilot".']
				: [];
		return { status: "loaded", config: { ...result.config, source: "config", warnings }, path };
	} catch (error) {
		return { status: "invalid", path, error: `Unreadable config: ${(error as Error).message}` };
	}
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
			const slash = m.model.indexOf("/");
			if (!deps.available(m.model.slice(0, slash), m.model.slice(slash + 1))) {
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
		return { ok: true, config: { ...config.config, source: "config", warnings: [...config.config.warnings, ...warnings] } };
	}

	// No config: fall back to the built-in tiny model defaults, filtered.
	const available: AutopilotModelSpec[] = [];
	const skipped: string[] = [];
	for (const m of DEFAULT_TINY_MODELS) {
		const slash = m.model.indexOf("/");
		if (deps.available(m.model.slice(0, slash), m.model.slice(slash + 1))) {
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

/** Format a model spec as a Pi CLI id (provider/model[:thinking]). */
export function modelCliId(spec: AutopilotModelSpec): string {
	return spec.thinking ? `${spec.model}:${spec.thinking}` : spec.model;
}
