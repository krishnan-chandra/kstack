import { type BoundaryValue, isObject, type JsonObject } from "../shared/validation.ts";
/** Router configuration from kstack.json. */

import { validateBoundedNumber } from "../shared/config-validate.ts";
import {
	loadValidatedSection,
	type ModelThinkingLevel,
	type ConfigLoad as SharedConfigLoad,
	THINKING_LEVELS,
} from "../shared/kstack-config.ts";
import { splitModelRef, validateModelSpecFields } from "../shared/model-spec.ts";
import { DEFAULT_REVIEW_MODELS, DEFAULTS, type ReviewModelSpec, type RouterConfig } from "./types.ts";

/** The only models allowed to run the explicit review route. */
const REVIEW_MODEL_ALLOWLIST: readonly string[] = ["anthropic/claude-opus-5-5", "openai/gpt-6-astra"];

type ConfigLoad = SharedConfigLoad<RouterConfig>;

export function validateRouterConfig(
	raw: BoundaryValue,
): { ok: true; config: RouterConfig } | { ok: false; error: string } {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "kstack-router config must be a JSON object." };
	}

	const obj =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	const config: RouterConfig = {};

	if (obj.classifier !== undefined) {
		if (!isObject(obj.classifier) || obj.classifier === null || Array.isArray(obj.classifier)) {
			return { ok: false, error: '"kstack-router.classifier" must be an object {"model": "...", "thinking"?}.' };
		}
		const classifier =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ obj.classifier as JsonObject;
		const fields = validateModelSpecFields(classifier, {
			requireLabel: false,
			errors: {
				label: () => '"kstack-router.classifier" does not use a label.',
				model: (value) => `"kstack-router.classifier.model" must be "provider/model", got ${JSON.stringify(value)}.`,
				thinking: () => `"kstack-router.classifier.thinking" must be one of ${THINKING_LEVELS.join(", ")}.`,
			},
		});
		if (!fields.ok) return fields;
		config.classifier = { model: fields.model, thinking: fields.thinking };
	}

	if (obj.timeoutSeconds !== undefined) {
		if (!validateBoundedNumber(obj.timeoutSeconds, { min: 1, max: 600 })) {
			return { ok: false, error: '"kstack-router.timeoutSeconds" must be a number between 1 and 600.' };
		}
		config.timeoutSeconds = obj.timeoutSeconds;
	}

	if (obj.review !== undefined) {
		const parsed = validateReviewConfig(obj.review);
		if (!parsed.ok) return parsed;
		config.review = parsed.review;
	}

	return { ok: true, config };
}

function validateReviewConfig(
	raw: BoundaryValue,
): { ok: true; review: NonNullable<RouterConfig["review"]> } | { ok: false; error: string } {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) {
		return { ok: false, error: '"kstack-router.review" must be an object {"models": [...]}.' };
	}
	const review =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	const rawModels = review.models;
	if (!Array.isArray(rawModels) || rawModels.length < 1 || rawModels.length > 5) {
		return { ok: false, error: '"kstack-router.review.models" must be an array of 1 to 5 model specs.' };
	}
	const models: ReviewModelSpec[] = [];
	for (const [index, rawModel] of rawModels.entries()) {
		if (!isObject(rawModel) || rawModel === null || Array.isArray(rawModel)) {
			return {
				ok: false,
				error: `"kstack-router.review.models[${index}]" must be an object {"model": "...", "thinking"?}.`,
			};
		}
		const fields = validateModelSpecFields(
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ rawModel as JsonObject,
			{
				requireLabel: false,
				errors: {
					label: () => `"kstack-router.review.models[${index}]" does not use a label.`,
					model: (value) =>
						`"kstack-router.review.models[${index}].model" must be "provider/model", got ${JSON.stringify(value)}.`,
					thinking: () =>
						`"kstack-router.review.models[${index}].thinking" must be one of ${THINKING_LEVELS.join(", ")}.`,
				},
			},
		);
		if (!fields.ok) return fields;
		if (!REVIEW_MODEL_ALLOWLIST.includes(fields.model)) {
			return {
				ok: false,
				error: `"kstack-router.review.models[${index}].model" must be one of ${REVIEW_MODEL_ALLOWLIST.join(", ")}; got ${fields.model}.`,
			};
		}
		const spec: ReviewModelSpec = { model: fields.model };
		if (fields.thinking) spec.thinking = fields.thinking;
		models.push(spec);
	}
	return { ok: true, review: { models } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	return loadValidatedSection("kstack-router", validateRouterConfig, env);
}

export interface ClassifierModelResolution {
	modelId: string;
	source: "config" | "default" | "active";
	/** Configured thinking level for the classifier child, if any. */
	thinking?: ModelThinkingLevel;
	warning?: string;
}

interface ResolveDeps {
	available: (provider: string, modelId: string) => boolean;
	activeModelId?: string;
}

export function resolveClassifierModel(
	config: RouterConfig | null,
	deps: ResolveDeps,
): ClassifierModelResolution | { ok: false; error: string } {
	if (config?.classifier) {
		const { provider, modelId } = splitModelRef(config.classifier.model);
		if (!deps.available(provider, modelId)) {
			return { ok: false, error: `Configured classifier model is unavailable: ${config.classifier.model}.` };
		}
		return { modelId: config.classifier.model, source: "config", thinking: config.classifier.thinking };
	}

	// Try default.
	const defaultModel = DEFAULTS.classifierModel;
	const { provider, modelId } = splitModelRef(defaultModel);
	if (deps.available(provider, modelId)) {
		return { modelId: defaultModel, source: "default", thinking: DEFAULTS.classifierThinking };
	}

	// Fall back to active model.
	if (deps.activeModelId) {
		return {
			modelId: deps.activeModelId,
			source: "active",
			warning: `Default classifier model (${defaultModel}) unavailable; using the active model instead. Classification latency and cost may be higher.`,
		};
	}

	return { ok: false, error: "No model available for routing classification." };
}

interface ReviewModelResolution {
	modelId: string;
	source: "config" | "default";
	/** Configured thinking level for the review turn, if any. */
	thinking?: ModelThinkingLevel;
}

/**
 * Resolve the first authenticated review model from the configured preference
 * list, falling back to the built-in Opus 5.5 / Astra order. Reviews never run
 * on the session's ambient model.
 */
export function resolveReviewModel(
	config: RouterConfig | null,
	deps: { available: (provider: string, modelId: string) => boolean },
): ReviewModelResolution | { ok: false; error: string } {
	const specs = (config?.review?.models ?? DEFAULT_REVIEW_MODELS).filter((spec) =>
		REVIEW_MODEL_ALLOWLIST.includes(spec.model),
	);
	for (const spec of specs) {
		const { provider, modelId } = splitModelRef(spec.model);
		if (deps.available(provider, modelId)) {
			return { modelId: spec.model, source: config?.review ? "config" : "default", thinking: spec.thinking };
		}
	}
	return {
		ok: false,
		error: `No review model is available. Reviews must use ${REVIEW_MODEL_ALLOWLIST.join(
			" or ",
		)}; tried: ${specs.map((spec) => spec.model).join(", ") || "(none allowed)"}.`,
	};
}
