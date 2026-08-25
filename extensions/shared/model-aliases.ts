/**
 * Shared model alias collection.
 *
 * Aliases give models short names that command-line style flags (for example
 * `/handoff --model terra`) can resolve instead of a full provider/model-id.
 * Two sources are centralized here so every extension resolves them the same
 * way:
 *
 * - kstack.json: any `{ "label": ..., "model": ..., "thinking"? }` entry, at
 *   any nesting depth (panel-review reviewers, arena runners, pr-autopilot
 *   models, ...). The label is the alias; the model and optional thinking
 *   level are the target.
 * - Model catalogue display names: the `name` field of models known to Pi
 *   (custom models.json entries always set one; built-in models have names
 *   like "Claude Sonnet 4.5").
 *
 * Alias keys are normalized case-insensitively; display names additionally
 * get a slug key so "Claude Sonnet 4.5" is reachable as `claude-sonnet-4.5`
 * when quoting is inconvenient.
 */
import { isThinkingLevel, MODEL_ID_RE, type ModelThinkingLevel } from "./kstack-config.ts";
import { MODEL_LABEL_RE } from "./model-spec.ts";
import { type BoundaryValue, isObject, isString, type JsonObject } from "./validation.ts";

/** A single alias mapping a short name to a provider/model-id reference. */
export interface ModelAlias {
	/** Normalized lookup key (lowercase, whitespace-collapsed, or slug). */
	key: string;
	/** Alias as written in the source, for diagnostics. */
	alias: string;
	/** Target `provider/model-id` reference. */
	modelRef: string;
	/** Default thinking level from the kstack.json entry, when present. */
	thinking?: ModelThinkingLevel;
	/** Where the alias came from, for diagnostics. */
	source: "kstack.json" | "model name";
}

/** Normalize an alias or user reference for comparison: lowercase, collapse whitespace. */
export function normalizeModelAliasKey(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Slug form of an alias: lowercase, non-alphanumeric runs become single dashes. */
function slugifyModelAlias(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9.]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function aliasKeys(alias: string): string[] {
	const keys = new Set<string>();
	const normalized = normalizeModelAliasKey(alias);
	if (normalized !== "") keys.add(normalized);
	const slug = slugifyModelAlias(alias);
	if (slug !== "") keys.add(slug);
	return [...keys];
}

/**
 * Collect aliases from every `{label, model, thinking?}` object found anywhere
 * in parsed kstack.json content. Entries whose label or model fails the shared
 * validation patterns are skipped; the owning extension's config validator is
 * responsible for reporting those.
 */
export function collectKstackModelAliases(root: JsonObject): ModelAlias[] {
	const aliases: ModelAlias[] = [];
	const seen = new Set<string>();
	const visit = (value: BoundaryValue): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isObject(value) || value === null) return;
		const record =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ value as JsonObject;
		if (
			isString(record.label) &&
			MODEL_LABEL_RE.test(record.label) &&
			isString(record.model) &&
			MODEL_ID_RE.test(record.model)
		) {
			const dedupeKey = `${record.label.toLowerCase()}->${record.model.toLowerCase()}`;
			if (!seen.has(dedupeKey)) {
				seen.add(dedupeKey);
				const thinking = isThinkingLevel(record.thinking) ? record.thinking : undefined;
				for (const key of aliasKeys(record.label)) {
					aliases.push({ key, alias: record.label, modelRef: record.model, thinking, source: "kstack.json" });
				}
			}
		}
		for (const nested of Object.values(record)) visit(nested);
	};
	visit(root);
	return aliases;
}

/**
 * Collect aliases from model display names. Names equal to the model id add
 * nothing over bare-id matching and are skipped.
 */
export function collectCatalogueNameAliases(
	models: readonly { provider: string; id: string; name?: string }[],
): ModelAlias[] {
	const aliases: ModelAlias[] = [];
	for (const model of models) {
		const name = model.name?.trim();
		if (!name || name === model.id) continue;
		for (const key of aliasKeys(name)) {
			aliases.push({ key, alias: name, modelRef: `${model.provider}/${model.id}`, source: "model name" });
		}
	}
	return aliases;
}

/** Return aliases whose key matches `reference` exactly after normalization. */
export function matchModelAliases(aliases: readonly ModelAlias[], reference: string): ModelAlias[] {
	if (aliases.length === 0) return [];
	const lower = reference.trim().toLowerCase();
	if (lower === "") return [];
	const normalized = normalizeModelAliasKey(reference);
	return aliases.filter((alias) => alias.key === lower || alias.key === normalized);
}
