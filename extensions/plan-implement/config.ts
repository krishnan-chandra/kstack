/** Unified kstack.json configuration and role-model resolution. */

import {
	getAgentDir,
	getKstackPath,
	loadKstackSection,
	MODEL_ID_RE,
	THINKING_LEVELS,
} from "../shared/kstack-config.ts";
import { LIMITS, type PlanImplementConfig, type ResolvedRoles, type RoleSpec, type ThinkingLevel } from "./types.ts";

export { getAgentDir, getKstackPath };

const HIGH_THINKING = new Set<ThinkingLevel>(["high", "xhigh", "max"]);

export const DEFAULT_PLANNERS: readonly RoleSpec[] = [
	{ model: "openai/gpt-5.6-sol", thinking: "high" },
	{ model: "openrouter/anthropic/claude-opus-4.6", thinking: "high" },
	{ model: "anthropic/claude-fable-5", thinking: "high" },
];

export const DEFAULT_IMPLEMENTERS: readonly RoleSpec[] = [
	{ model: "openai/gpt-5.6-terra", thinking: "medium" },
	{ model: "openrouter/google/gemini-3.7-flash", thinking: "high" },
	{ model: "openrouter/deepseek/deepseek-v4-flash", thinking: "high" },
	{ model: "openrouter/moonshotai/kimi-k3", thinking: "medium" },
];

export type ConfigLoad =
	| { status: "loaded"; config: PlanImplementConfig; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

function validateRole(
	raw: unknown,
	role: "planner" | "implementer",
): { ok: true; spec: RoleSpec } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: `"${role}" must be {"model":"provider/model","thinking"?}.` };
	}
	const value = raw as Record<string, unknown>;
	if (typeof value.model !== "string" || !MODEL_ID_RE.test(value.model)) {
		return { ok: false, error: `"${role}.model" must be a provider/model id.` };
	}
	if (
		value.thinking !== undefined &&
		(typeof value.thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value.thinking))
	) {
		return { ok: false, error: `"${role}.thinking" must be one of ${THINKING_LEVELS.join(", ")}.` };
	}
	const thinking = (value.thinking ?? (role === "planner" ? "high" : undefined)) as ThinkingLevel | undefined;
	if (role === "planner" && (!thinking || !HIGH_THINKING.has(thinking))) {
		return { ok: false, error: '"planner.thinking" must be high, xhigh, or max.' };
	}
	return { ok: true, spec: { model: value.model, thinking } };
}

export function validateConfig(raw: unknown): { ok: true; config: PlanImplementConfig } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "plan-implement config must be a JSON object." };
	}
	const value = raw as Record<string, unknown>;
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
			typeof value.timeoutMinutes !== "number" ||
			!Number.isInteger(value.timeoutMinutes) ||
			value.timeoutMinutes < LIMITS.minTimeoutMinutes ||
			value.timeoutMinutes > LIMITS.maxTimeoutMinutes
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
	const section = loadKstackSection("plan-implement", env);
	if (section.status !== "found") return section;
	const result = validateConfig(section.value);
	return result.ok
		? { status: "loaded", config: result.config, path: section.path }
		: { status: "invalid", path: section.path, error: result.error };
}

export interface ResolveDeps {
	available: (provider: string, modelId: string) => boolean;
}

function isAvailable(spec: RoleSpec, deps: ResolveDeps): boolean {
	const slash = spec.model.indexOf("/");
	return deps.available(spec.model.slice(0, slash), spec.model.slice(slash + 1));
}

export function modelCliId(spec: RoleSpec): string {
	return spec.thinking ? `${spec.model}:${spec.thinking}` : spec.model;
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
