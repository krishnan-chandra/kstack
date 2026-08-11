/**
 * Panel reviewer configuration: discovery, validation, and model resolution.
 *
 * Config lives at `$PI_CODING_AGENT_DIR/panel-review.json`
 * (fallback: `~/.pi/agent/panel-review.json`):
 *
 *   {
 *     "reviewers": [
 *       { "label": "qwen", "model": "qwen/qwen3.8-max", "thinking": "high" },
 *       { "label": "kimi", "model": "openrouter/moonshotai/kimi-k3", "thinking": "high" }
 *     ],
 *     "maxConcurrency": 4
 *   }
 *
 * With no config file, the built-in low-cost DEFAULT_PANEL is used, filtered
 * to models available in the registry; scoped models and finally the active
 * model are the fallback chain.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PanelConfig, ReviewerSpec } from "./types.ts";

export const MIN_REVIEWERS = 2;
export const MAX_REVIEWERS = 4;
export const DEFAULT_MAX_CONCURRENCY = 4;

/** Thinking levels Pi understands; used to validate config entries. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Built-in low-cost default panel, used when no panel-review.json exists.
 * Entries are filtered against the model registry at resolution time; at
 * least MIN_REVIEWERS must be available or the fallback chain continues.
 */
export const DEFAULT_PANEL: ReviewerSpec[] = [
	{ label: "qwen", model: "openrouter/qwen/qwen3.8-max", thinking: "high" },
	{ label: "kimi", model: "openrouter/moonshotai/kimi-k3", thinking: "high" },
	{ label: "sol", model: "openai/gpt-5.6-sol", thinking: "low" },
];

export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return join(homedir(), ".pi", "agent");
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "panel-review.json");
}

export type ConfigLoad =
	| { status: "loaded"; config: PanelConfig; path: string }
	| { status: "missing"; path: string }
	| { status: "invalid"; path: string; error: string };

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
		if (typeof r.label !== "string" || !/^[A-Za-z0-9_-]{1,16}$/.test(r.label)) {
			return { ok: false, error: `Invalid reviewer label ${JSON.stringify(r.label)}.` };
		}
		if (labels.has(r.label)) {
			return { ok: false, error: `Duplicate reviewer label "${r.label}".` };
		}
		labels.add(r.label);
		if (typeof r.model !== "string" || !/^[^/\s]+(\/[^/\s]+)+$/.test(r.model)) {
			return {
				ok: false,
				error: `Reviewer "${r.label}" has invalid model ${JSON.stringify(r.model)}; expected "provider/model" (extra path segments allowed, e.g. "openrouter/moonshotai/kimi-k3").`,
			};
		}
		if (
			r.thinking !== undefined &&
			(typeof r.thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(r.thinking))
		) {
			return {
				ok: false,
				error: `Reviewer "${r.label}" has invalid thinking level ${JSON.stringify(r.thinking)}; expected one of ${THINKING_LEVELS.join(", ")}.`,
			};
		}
		reviewers.push({ label: r.label, model: r.model, thinking: r.thinking as string | undefined });
	}
	let maxConcurrency = DEFAULT_MAX_CONCURRENCY;
	if (obj.maxConcurrency !== undefined) {
		if (
			typeof obj.maxConcurrency !== "number" ||
			!Number.isInteger(obj.maxConcurrency) ||
			obj.maxConcurrency < 1 ||
			obj.maxConcurrency > MAX_REVIEWERS
		) {
			return { ok: false, error: `"maxConcurrency" must be an integer between 1 and ${MAX_REVIEWERS}.` };
		}
		maxConcurrency = obj.maxConcurrency;
	}
	return { ok: true, config: { reviewers, maxConcurrency } };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigLoad {
	const path = getConfigPath(env);
	if (!existsSync(path)) return { status: "missing", path };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const result = validateConfig(raw);
		if (!result.ok) return { status: "invalid", path, error: result.error };
		return { status: "loaded", config: result.config, path };
	} catch (err) {
		return { status: "invalid", path, error: `Unreadable config: ${(err as Error).message}` };
	}
}

/** Model the CLI accepts: "provider/model" with optional ":thinking" suffix. */
export function modelCliId(spec: ReviewerSpec): string {
	return spec.thinking ? `${spec.model}:${spec.thinking}` : spec.model;
}

export interface ModelLike {
	provider: string;
	id: string;
}

export interface ResolveDeps {
	/** Resolve "provider/model" against the registry; return undefined when unavailable. */
	find: (provider: string, modelId: string) => ModelLike | undefined;
	/** Scoped models for the session (may be empty = unscoped). */
	scopedModels: { model: ModelLike; thinkingLevel?: string }[];
	/** Currently active model. */
	activeModel?: ModelLike;
}

export type ReviewerResolution =
	| { ok: true; reviewers: ReviewerSpec[]; maxConcurrency: number; warnings: string[] }
	| { ok: false; error: string };

/**
 * Resolve the reviewer panel from config, falling back to scoped models and
 * finally to the active model (two independent runs, reduced diversity).
 */
export function resolveReviewers(config: PanelConfig | null, deps: ResolveDeps): ReviewerResolution {
	const warnings: string[] = [];

	if (config) {
		const unavailable: string[] = [];
		for (const r of config.reviewers) {
			const slash = r.model.indexOf("/");
			if (!deps.find(r.model.slice(0, slash), r.model.slice(slash + 1))) {
				unavailable.push(`${r.label}: ${r.model}`);
			}
		}
		if (unavailable.length > 0) {
			return {
				ok: false,
				error:
					"Configured reviewer models are unavailable or unauthenticated:\n  " +
					unavailable.join("\n  ") +
					"\nFix panel-review.json or authenticate the providers.",
			};
		}
		return { ok: true, reviewers: config.reviewers, maxConcurrency: config.maxConcurrency, warnings };
	}

	// No config: try the built-in low-cost default panel, filtered to models
	// available in the registry. Skipped entries are surfaced as warnings.
	const defaultAvailable: ReviewerSpec[] = [];
	const defaultSkipped: string[] = [];
	for (const r of DEFAULT_PANEL) {
		const slash = r.model.indexOf("/");
		if (deps.find(r.model.slice(0, slash), r.model.slice(slash + 1))) defaultAvailable.push(r);
		else defaultSkipped.push(r.model);
	}
	if (defaultSkipped.length > 0) {
		warnings.push(`Default panel models unavailable, skipping: ${defaultSkipped.join(", ")}.`);
	}
	if (defaultAvailable.length >= MIN_REVIEWERS) {
		return { ok: true, reviewers: defaultAvailable, maxConcurrency: DEFAULT_MAX_CONCURRENCY, warnings };
	}

	// Default panel unavailable: pick up to four distinct scoped models,
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
				"No models available for panel review. Configure reviewers in panel-review.json " +
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
