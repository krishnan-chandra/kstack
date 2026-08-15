/** Router configuration from kstack.json. */

import { validateBoundedNumber } from "../shared/config-validate.ts";
import { loadKstackSection, THINKING_LEVELS } from "../shared/kstack-config.ts";
import { splitModelRef, validateModelSpecFields } from "../shared/model-spec.ts";
import { DEFAULTS, type RouterConfig } from "./types.ts";

export type ConfigLoad =
	| { status: "loaded"; config: RouterConfig; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

export function validateRouterConfig(raw: unknown): { ok: true; config: RouterConfig } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "kstack-router config must be a JSON object." };
	}

	const obj = raw as Record<string, unknown>;
	const config: RouterConfig = {};

	if (obj.classifier !== undefined) {
		if (typeof obj.classifier !== "object" || obj.classifier === null || Array.isArray(obj.classifier)) {
			return { ok: false, error: '"kstack-router.classifier" must be an object {"model": "...", "thinking"?}.' };
		}
		const classifier = obj.classifier as Record<string, unknown>;
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

	return { ok: true, config };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	const section = loadKstackSection("kstack-router", env);
	if (section.status !== "found") return section;
	const result = validateRouterConfig(section.value);
	return result.ok
		? { status: "loaded", config: result.config, path: section.path }
		: { status: "invalid", path: section.path, error: result.error };
}

export interface ClassifierModelResolution {
	modelId: string;
	source: "config" | "default" | "active";
	/** Configured thinking level for the classifier child, if any. */
	thinking?: string;
	warning?: string;
}

export interface ResolveDeps {
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
