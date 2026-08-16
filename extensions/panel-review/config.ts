/**
 * Panel reviewer configuration: discovery, validation, and model resolution.
 *
 * Config lives in the `"panel-review"` section of
 * `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`):
 *
 *   {
 *     "panel-review": {
 *       "reviewers": [
 *         { "label": "gemini", "model": "google-vertex/gemini-3.7-flash", "thinking": "high" }
 *       ],
 *       "maxConcurrency": 5,
 *       "timeoutMinutes": 10,
 *       "maxRuntimeMinutes": 30,
 *       "synthesis": { "model": "openai/gpt-5.6-terra", "thinking": "medium" }
 *     }
 *   }
 *
 * "synthesis" is required: it picks the model that merges the reviewer
 * reports into the lead verdict after the panel finishes.
 *
 * "timeoutMinutes" is the per-child idle limit: any child output resets the
 * timer, so slow-but-progressing reviewers are not killed. "maxRuntimeMinutes"
 * is the absolute per-child ceiling regardless of activity.
 *
 * With no config file, the built-in low-cost DEFAULT_PANEL is used, filtered
 * to models available in the registry; scoped models and finally the active
 * model are the fallback chain. Synthesis then runs on the small, fast
 * DEFAULT_SYNTHESIS model, falling back to the active model when it is
 * unavailable.
 */

import { validateBoundedNumber } from "../shared/config-validate.ts";
import { loadValidatedSection, type ConfigLoad as SharedConfigLoad, THINKING_LEVELS } from "../shared/kstack-config.ts";
import { MODEL_LABEL_RE, splitModelRef, validateModelSpecFields } from "../shared/model-spec.ts";
import type { PanelConfig, ReviewerSpec } from "./types.ts";

export { modelCliId } from "../shared/model-spec.ts";

const MIN_REVIEWERS = 2;
const MAX_REVIEWERS = 5;
const DEFAULT_MAX_CONCURRENCY = 5;
export const DEFAULT_TIMEOUT_MINUTES = 10;
export const DEFAULT_MAX_RUNTIME_MINUTES = 30;

/** Thinking levels Pi understands; used to validate config entries. */

/**
 * Built-in low-cost default panel, used when no kstack.json exists.
 * Entries are filtered against the model registry at resolution time; at
 * least MIN_REVIEWERS must be available or the fallback chain continues.
 */
export const DEFAULT_PANEL: ReviewerSpec[] = [
	{ label: "sonnet", model: "anthropic/claude-sonnet-5", thinking: "medium" },
	// DeepSeek V4 Pro at high thinking repeatedly produced no output for 20+ minutes;
	// medium responds promptly at similar review quality.
	{ label: "deepseek", model: "openrouter/deepseek/deepseek-v4-pro", thinking: "medium" },
	{ label: "kimi", model: "openrouter/moonshotai/kimi-k3", thinking: "medium" },
	{ label: "gemini", model: "google-vertex/gemini-3.7-flash", thinking: "high" },
];

/**
 * Built-in synthesis model for the no-config path. Config files must name
 * their synthesis model explicitly.
 */
export const DEFAULT_SYNTHESIS = { model: "openai/gpt-5.6-terra", thinking: "medium" } as const;

export type ConfigLoad = SharedConfigLoad<PanelConfig>;

export function validateConfig(raw: unknown): { ok: true; config: PanelConfig } | { ok: false; error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "Config must be a JSON object." };
	}
	const obj = raw as Record<string, unknown>;
	if (!Array.isArray(obj.reviewers)) {
		return { ok: false, error: '"reviewers" must be an array of {label, model, thinking?}.' };
	}
	if (obj.reviewers.length < MIN_REVIEWERS || obj.reviewers.length > MAX_REVIEWERS) {
		return { ok: false, error: `panel-review requires ${MIN_REVIEWERS}–${MAX_REVIEWERS} reviewers.` };
	}
	const labels = new Set<string>();
	const reviewers: ReviewerSpec[] = [];
	for (const entry of obj.reviewers) {
		if (typeof entry !== "object" || entry === null) {
			return { ok: false, error: "Each reviewer must be an object." };
		}
		const r = entry as Record<string, unknown>;
		if (typeof r.label !== "string" || !MODEL_LABEL_RE.test(r.label)) {
			return { ok: false, error: `Invalid reviewer label ${JSON.stringify(r.label)}.` };
		}
		if (labels.has(r.label)) {
			return { ok: false, error: `Duplicate reviewer label "${r.label}".` };
		}
		labels.add(r.label);
		const fields = validateModelSpecFields(r, {
			requireLabel: true,
			errors: {
				label: (value) => `Invalid reviewer label ${JSON.stringify(value)}.`,
				model: (value) =>
					`Reviewer "${r.label}" has invalid model ${JSON.stringify(value)}; expected "provider/model" (extra path segments allowed, e.g. "openrouter/deepseek/deepseek-v4-pro").`,
				thinking: (value) =>
					`Reviewer "${r.label}" has invalid thinking level ${JSON.stringify(value)}; expected one of ${THINKING_LEVELS.join(", ")}.`,
			},
		});
		if (!fields.ok) return fields;
		reviewers.push({ label: r.label, model: fields.model, thinking: fields.thinking });
	}
	let maxConcurrency = DEFAULT_MAX_CONCURRENCY;
	if (obj.maxConcurrency !== undefined) {
		if (!validateBoundedNumber(obj.maxConcurrency, { integer: true, min: 1, max: MAX_REVIEWERS })) {
			return { ok: false, error: `"maxConcurrency" must be an integer between 1 and ${MAX_REVIEWERS}.` };
		}
		maxConcurrency = obj.maxConcurrency;
	}
	const timeouts = validateTimeouts(obj);
	if (!timeouts.ok) return timeouts;
	const synthesis = validateSynthesis(obj);
	if (!synthesis.ok) return synthesis;
	return {
		ok: true,
		config: {
			reviewers,
			maxConcurrency,
			timeoutMinutes: timeouts.timeoutMinutes,
			maxRuntimeMinutes: timeouts.maxRuntimeMinutes,
			synthesis: synthesis.spec,
		},
	};
}

function validateTimeouts(
	obj: Record<string, unknown>,
): { ok: true; timeoutMinutes: number; maxRuntimeMinutes: number } | { ok: false; error: string } {
	const timeoutMinutes = obj.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
	if (!validateBoundedNumber(timeoutMinutes, { min: Number.MIN_VALUE, max: Number.MAX_VALUE })) {
		return {
			ok: false,
			error: '"timeoutMinutes" must be a positive number (per-child idle limit; output resets the timer).',
		};
	}
	const maxRuntimeMinutes = obj.maxRuntimeMinutes ?? DEFAULT_MAX_RUNTIME_MINUTES;
	if (!validateBoundedNumber(maxRuntimeMinutes, { min: Number.MIN_VALUE, max: Number.MAX_VALUE })) {
		return { ok: false, error: '"maxRuntimeMinutes" must be a positive number (absolute per-child ceiling).' };
	}
	if (maxRuntimeMinutes < timeoutMinutes) {
		return { ok: false, error: '"maxRuntimeMinutes" must be >= "timeoutMinutes".' };
	}
	return { ok: true, timeoutMinutes, maxRuntimeMinutes };
}

function validateSynthesis(
	obj: Record<string, unknown>,
): { ok: true; spec: { model: string; thinking?: string } } | { ok: false; error: string } {
	if (typeof obj.synthesis !== "object" || obj.synthesis === null || Array.isArray(obj.synthesis)) {
		return {
			ok: false,
			error:
				'"synthesis" is required: {"model": "provider/model", "thinking"?} — the model that merges reviewer reports into the verdict.',
		};
	}
	const s = obj.synthesis as Record<string, unknown>;
	const fields = validateModelSpecFields(s, {
		requireLabel: false,
		errors: {
			label: () => '"synthesis" does not use a label.',
			model: (value) =>
				`"synthesis.model" must be "provider/model" (extra path segments allowed), got ${JSON.stringify(value)}.`,
			thinking: (value) =>
				`"synthesis.thinking" must be one of ${THINKING_LEVELS.join(", ")}, got ${JSON.stringify(value)}.`,
		},
	});
	return fields.ok ? { ok: true, spec: { model: fields.model, thinking: fields.thinking } } : fields;
}

/**
 * Load panel-review config from the `"panel-review"` section of
 * `kstack.json`. Returns "missing" when the file is absent or has no
 * `"panel-review"` key.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	return loadValidatedSection("panel-review", validateConfig, env);
}

interface ModelLike {
	provider: string;
	id: string;
}

export interface ResolveDeps {
	/** Resolve "provider/model" against the registry; return undefined when unavailable. */
	find: (provider: string, modelId: string) => ModelLike | undefined;
	/** Scoped models for the session (may be empty = unscoped). */
	scopedModels: readonly { model: ModelLike; thinkingLevel?: string }[];
	/** Currently active model. */
	activeModel?: ModelLike;
}

type ReviewerResolution =
	| { ok: true; reviewers: ReviewerSpec[]; maxConcurrency: number; warnings: string[] }
	| { ok: false; error: string };

type SynthesisResolution =
	| { ok: true; model: string; thinking?: string; source: "config" | "default" | "active"; warnings: string[] }
	| { ok: false; error: string };

/**
 * Resolve the synthesis model. With a config file the required "synthesis"
 * entry must be available (hard error otherwise, matching reviewer policy).
 * Without one, the built-in small, fast DEFAULT_SYNTHESIS model is used,
 * falling back to the active model with a warning.
 */
export function resolveSynthesisModel(
	config: Pick<PanelConfig, "synthesis"> | null,
	deps: ResolveDeps,
): SynthesisResolution {
	const warnings: string[] = [];
	if (config) {
		const { provider, modelId } = splitModelRef(config.synthesis.model);
		if (!deps.find(provider, modelId)) {
			return {
				ok: false,
				error:
					`Configured synthesis model is unavailable or unauthenticated: ${config.synthesis.model}\n` +
					"Fix the panel-review section in kstack.json or authenticate the provider.",
			};
		}
		return { ok: true, model: config.synthesis.model, thinking: config.synthesis.thinking, source: "config", warnings };
	}
	const { provider, modelId } = splitModelRef(DEFAULT_SYNTHESIS.model);
	if (deps.find(provider, modelId)) {
		return {
			ok: true,
			model: DEFAULT_SYNTHESIS.model,
			thinking: DEFAULT_SYNTHESIS.thinking,
			source: "default",
			warnings,
		};
	}
	if (deps.activeModel) {
		warnings.push(`Default synthesis model ${DEFAULT_SYNTHESIS.model} unavailable; using the active model instead.`);
		return {
			ok: true,
			model: `${deps.activeModel.provider}/${deps.activeModel.id}`,
			source: "active",
			warnings,
		};
	}
	return {
		ok: false,
		error: `No model available for synthesis (${DEFAULT_SYNTHESIS.model} unavailable and no active model).`,
	};
}

/**
 * Resolve the reviewer panel from config, falling back to scoped models and
 * finally to the active model (two independent runs, reduced diversity).
 */
export function resolveReviewers(
	config: Pick<PanelConfig, "reviewers" | "maxConcurrency"> | null,
	deps: ResolveDeps,
): ReviewerResolution {
	const warnings: string[] = [];

	if (config) {
		const unavailable: string[] = [];
		for (const r of config.reviewers) {
			const { provider, modelId } = splitModelRef(r.model);
			if (!deps.find(provider, modelId)) {
				unavailable.push(`${r.label}: ${r.model}`);
			}
		}
		if (unavailable.length > 0) {
			return {
				ok: false,
				error:
					"Configured reviewer models are unavailable or unauthenticated:\n  " +
					unavailable.join("\n  ") +
					"\nFix the panel-review section in kstack.json or authenticate the providers.",
			};
		}
		return { ok: true, reviewers: config.reviewers, maxConcurrency: config.maxConcurrency, warnings };
	}

	// No config: try the built-in low-cost default panel, filtered to models
	// available in the registry. Skipped entries are surfaced as warnings.
	const defaultAvailable: ReviewerSpec[] = [];
	const defaultSkipped: string[] = [];
	for (const r of DEFAULT_PANEL) {
		const { provider, modelId } = splitModelRef(r.model);
		if (deps.find(provider, modelId)) defaultAvailable.push(r);
		else defaultSkipped.push(r.model);
	}
	if (defaultSkipped.length > 0) {
		warnings.push(`Default panel models unavailable, skipping: ${defaultSkipped.join(", ")}.`);
	}
	if (defaultAvailable.length >= MIN_REVIEWERS) {
		return { ok: true, reviewers: defaultAvailable, maxConcurrency: DEFAULT_MAX_CONCURRENCY, warnings };
	}

	// Default panel unavailable: pick up to five distinct scoped models,
	// preferring provider diversity.
	const seen = new Set<string>();
	const distinct: { model: ModelLike; thinkingLevel?: string }[] = [];
	for (const entry of deps.scopedModels) {
		const key = `${entry.model.provider}/${entry.model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		distinct.push(entry);
	}
	// Round-robin across providers so one provider cannot fill the panel.
	const byProvider = new Map<string, { model: ModelLike; thinkingLevel?: string }[]>();
	for (const entry of distinct) {
		const list = byProvider.get(entry.model.provider) ?? [];
		list.push(entry);
		byProvider.set(entry.model.provider, list);
	}
	const picked: { model: ModelLike; thinkingLevel?: string }[] = [];
	while (picked.length < Math.min(MAX_REVIEWERS, distinct.length)) {
		let progressed = false;
		for (const list of byProvider.values()) {
			const next = list.shift();
			if (next) {
				picked.push(next);
				progressed = true;
				if (picked.length >= Math.min(MAX_REVIEWERS, distinct.length)) break;
			}
		}
		if (!progressed) break;
	}

	if (picked.length >= MIN_REVIEWERS) {
		const reviewers = picked.map((entry, i) => ({
			label: String.fromCharCode(65 + i),
			model: `${entry.model.provider}/${entry.model.id}`,
			thinking: entry.thinkingLevel,
		}));
		return { ok: true, reviewers, maxConcurrency: DEFAULT_MAX_CONCURRENCY, warnings };
	}

	// Only the active model (or one scoped model) is available: run two
	// independent reviewers with it. Independence remains; diversity is reduced.
	const only = picked[0]?.model ?? deps.activeModel;
	if (!only) {
		return {
			ok: false,
			error:
				"No models available for panel review. Configure reviewers in kstack.json " +
				"or authenticate at least one provider.",
		};
	}
	warnings.push(
		"Only one model is available; running two independent reviewers with it. " +
			"Independence is preserved but model diversity is reduced.",
	);
	const model = `${only.provider}/${only.id}`;
	return {
		ok: true,
		reviewers: [
			{ label: "A", model, thinking: picked[0]?.thinkingLevel },
			{ label: "B", model, thinking: picked[0]?.thinkingLevel },
		],
		maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		warnings,
	};
}
