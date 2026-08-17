import { isThinkingLevel, MODEL_ID_RE, type ModelThinkingLevel, THINKING_LEVELS } from "./kstack-config.ts";

/** A model reference as configured in kstack.json sections. */
export interface ModelSpec {
	label?: string;
	model: string;
	thinking?: ModelThinkingLevel;
}

/** Format a spec as a Pi CLI id (provider/model[:thinking]). */
export function modelCliId(spec: ModelSpec): string {
	return spec.thinking ? `${spec.model}:${spec.thinking}` : spec.model;
}

/** Split `provider/model-id`; extra path segments stay in the model id. */
export function splitModelRef(ref: string): { provider: string; modelId: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export const MODEL_LABEL_RE = /^[A-Za-z0-9_-]{1,16}$/;

interface ModelSpecFieldRules {
	requireLabel: boolean;
	allowedThinking?: readonly string[];
	errors: {
		label(value: unknown): string;
		model(value: unknown): string;
		thinking(value: unknown): string;
	};
}

type ModelSpecFieldResult =
	| { ok: true; label?: string; model: string; thinking?: ModelThinkingLevel }
	| { ok: false; error: string };

/** Validate the common model-spec fields while callers retain their error text. */
export function validateModelSpecFields(
	value: Record<string, unknown>,
	rules: ModelSpecFieldRules,
): ModelSpecFieldResult {
	if (rules.requireLabel && (typeof value.label !== "string" || !MODEL_LABEL_RE.test(value.label))) {
		return { ok: false, error: rules.errors.label(value.label) };
	}
	if (typeof value.model !== "string" || !MODEL_ID_RE.test(value.model)) {
		return { ok: false, error: rules.errors.model(value.model) };
	}
	const allowedThinking = rules.allowedThinking ?? THINKING_LEVELS;
	if (value.thinking !== undefined && (!isThinkingLevel(value.thinking) || !allowedThinking.includes(value.thinking))) {
		return { ok: false, error: rules.errors.thinking(value.thinking) };
	}
	return {
		ok: true,
		...(rules.requireLabel && typeof value.label === "string" ? { label: value.label } : {}),
		model: value.model,
		...(isThinkingLevel(value.thinking) ? { thinking: value.thinking } : {}),
	};
}
