import { loadKstackSection, type ThinkingLevel } from "../shared/kstack-config.ts";
import { LIMITS, type FastImplementConfig, type ResolvedRole, type RoleSpec } from "./types.ts";

/**
 * Fast mode has no independent planner or reviewer, so the implementer model
 * set is the only quality control. Only these model/thinking pairs may run.
 */
export const ALLOWED_IMPLEMENTERS: readonly RoleSpec[] = [
	{ model: "openai/gpt-5.6-sol", thinking: "low" },
	{ model: "openrouter/x-ai/grok-4.6", thinking: "high" },
	{ model: "anthropic/claude-opus-5", thinking: "medium" },
];
export const DEFAULT_IMPLEMENTERS: readonly RoleSpec[] = ALLOWED_IMPLEMENTERS;

function allowedPairs(): string {
	return ALLOWED_IMPLEMENTERS.map((spec) => `${spec.model}:${spec.thinking}`).join(", ");
}

export type ConfigLoad = { status: "loaded"; config: FastImplementConfig; path: string } | { status: "missing"; path: string } | { status: "invalid"; path: string; error: string };

export function validateConfig(raw: unknown): { ok: true; config: FastImplementConfig } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "fast-implement config must be a JSON object." };
	const value = raw as Record<string, unknown>; const role = value.implementer;
	if (typeof role !== "object" || role === null || Array.isArray(role)) return { ok: false, error: '"implementer" must be a model role.' };
	const spec = role as Record<string, unknown>;
	const allowed = ALLOWED_IMPLEMENTERS.find((candidate) => candidate.model === spec.model);
	if (!allowed) return { ok: false, error: `"implementer.model" must be one of the bounded fast implementers: ${allowedPairs()}.` };
	if (spec.thinking !== undefined && spec.thinking !== allowed.thinking) return { ok: false, error: `"implementer.thinking" for ${allowed.model} must be "${allowed.thinking}".` };
	const timeout = value.timeoutMinutes ?? LIMITS.defaultTimeoutMinutes;
	if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < LIMITS.minTimeoutMinutes || timeout > LIMITS.maxTimeoutMinutes) return { ok: false, error: `"timeoutMinutes" must be ${LIMITS.minTimeoutMinutes}-${LIMITS.maxTimeoutMinutes}.` };
	return { ok: true, config: { implementer: { model: allowed.model, thinking: allowed.thinking as ThinkingLevel | undefined }, timeoutMinutes: timeout } };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad { const section = loadKstackSection("fast-implement", env); if (section.status !== "found") return section; const result = validateConfig(section.value); return result.ok ? { status: "loaded", config: result.config, path: section.path } : { status: "invalid", path: section.path, error: result.error }; }
export function resolveRole(config: FastImplementConfig | null, available: (provider: string, model: string) => boolean): { ok: true; role: ResolvedRole } | { ok: false; error: string } {
	const candidates = config ? [config.implementer] : DEFAULT_IMPLEMENTERS; const spec = candidates.find((candidate) => { const slash = candidate.model.indexOf("/"); return available(candidate.model.slice(0, slash), candidate.model.slice(slash + 1)); });
	if (!spec) return { ok: false, error: `No authenticated child-compatible fast implementer is available. Tried: ${candidates.map((candidate) => candidate.model).join(", ")}.` };
	return { ok: true, role: { implementer: spec, timeoutMinutes: config?.timeoutMinutes ?? LIMITS.defaultTimeoutMinutes, source: config ? "config" : "default" } };
}
export function modelCliId(role: RoleSpec): string { return role.thinking ? `${role.model}:${role.thinking}` : role.model; }
