import { isThinkingLevel, MODEL_ID_RE, type ModelThinkingLevel, THINKING_LEVELS } from "./kstack-config.ts";
import { type BoundaryValue, isString, type JsonObject } from "./validation.ts";

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
export function splitModelRef(ref: string) {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export const MODEL_LABEL_RE = /^[A-Za-z0-9_-]{1,16}$/;

interface ModelSpecFieldRules {
	requireLabel: boolean;
	allowedThinking?: readonly string[];
	errors: {
		label(value: BoundaryValue): string;
		model(value: BoundaryValue): string;
		thinking(value: BoundaryValue): string;
	};
}

type ModelSpecFieldResult =
	| { ok: true; label?: string; model: string; thinking?: ModelThinkingLevel }
	| { ok: false; error: string };

/** Validate the common model-spec fields while callers retain their error text. */
export function validateModelSpecFields(value: JsonObject, rules: ModelSpecFieldRules): ModelSpecFieldResult {
	if (rules.requireLabel && (!isString(value.label) || !MODEL_LABEL_RE.test(value.label))) {
		return { ok: false, error: rules.errors.label(value.label) };
	}
	if (!isString(value.model) || !MODEL_ID_RE.test(value.model)) {
		return { ok: false, error: rules.errors.model(value.model) };
	}
	const allowedThinking = rules.allowedThinking ?? THINKING_LEVELS;
	if (value.thinking !== undefined && (!isThinkingLevel(value.thinking) || !allowedThinking.includes(value.thinking))) {
		return { ok: false, error: rules.errors.thinking(value.thinking) };
	}
	return {
		ok: true,
		...(rules.requireLabel && isString(value.label) ? { label: value.label } : undefined),
		model: value.model,
		...(isThinkingLevel(value.thinking) ? { thinking: value.thinking } : undefined),
	};
}
