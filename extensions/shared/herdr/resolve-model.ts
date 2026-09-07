/** Resolve skill-facing model references through kstack.json aliases and section defaults. */

import {
	isThinkingLevel,
	loadKstackRoot,
	MODEL_ID_RE,
	type ModelThinkingLevel,
	type PlanAdversaryModel,
	validatePlanAdversaryConfig,
} from "../kstack-config.ts";
import { collectKstackModelAliases, type ModelAlias, matchModelAliases } from "../model-aliases.ts";
import { type BoundaryValue, isObject, isString, type JsonObject } from "../validation.ts";

interface ResolveModelRequest {
	argument?: string;
	configured?: PlanAdversaryModel;
	aliases: readonly ModelAlias[];
	section: string;
	key: string;
}

interface ResolveConfiguredModelRequest {
	argument?: string;
	section: string;
	key: string;
	env?: NodeJS.ProcessEnv;
}

type ResolveModelResult = { ok: true; ref: string } | { ok: false; error: string };
type ConfiguredModelResult = { ok: true; model: PlanAdversaryModel | undefined } | { ok: false; error: string };

interface ParsedModelReference {
	base: string;
	thinking?: ModelThinkingLevel;
}

function splitThinking(reference: string): ParsedModelReference {
	const separator = reference.lastIndexOf(":");
	if (separator < 0) return { base: reference };
	const suffix = reference.slice(separator + 1);
	if (!isThinkingLevel(suffix)) return { base: reference };
	return { base: reference.slice(0, separator), thinking: suffix };
}

function withThinking(model: string, thinking: ModelThinkingLevel | undefined): string {
	return thinking ? `${model}:${thinking}` : model;
}

function resolveReference(reference: string, aliases: readonly ModelAlias[]): ResolveModelResult {
	const trimmed = reference.trim();
	if (!trimmed) return { ok: false, error: "model reference must not be empty." };
	const parsed = splitThinking(trimmed);
	if (MODEL_ID_RE.test(parsed.base)) return { ok: true, ref: withThinking(parsed.base, parsed.thinking) };
	const matches = matchModelAliases(aliases, parsed.base);
	if (matches.length === 0)
		return { ok: false, error: `model alias ${JSON.stringify(parsed.base)} was not found in kstack.json.` };
	const refs = new Set(matches.map((match) => withThinking(match.modelRef, parsed.thinking ?? match.thinking)));
	if (refs.size !== 1) {
		return { ok: false, error: `model alias ${JSON.stringify(parsed.base)} is ambiguous in kstack.json.` };
	}
	const [ref] = refs;
	return ref ? { ok: true, ref } : { ok: false, error: `model alias ${JSON.stringify(parsed.base)} has no target.` };
}

/** Resolve an explicit model argument, then a configured object or alias. */
export function resolveModelRef(request: ResolveModelRequest): ResolveModelResult {
	if (request.argument !== undefined) return resolveReference(request.argument, request.aliases);
	if (request.configured === undefined) {
		return {
			ok: false,
			error: `No model configured for ${request.section}.${request.key}. Set it in kstack.json or pass --model.`,
		};
	}
	if (isString(request.configured)) return resolveReference(request.configured, request.aliases);
	return { ok: true, ref: withThinking(request.configured.model, request.configured.thinking) };
}

function genericConfiguredModel(value: BoundaryValue, section: string, key: string): ConfiguredModelResult {
	if (value === undefined) return { ok: true, model: undefined };
	if (isString(value)) return { ok: true, model: value };
	if (!isObject(value) || value === null || Array.isArray(value)) {
		return { ok: false, error: `${section}.${key} must be a model object or alias string.` };
	}
	// SAFETY: the object guard above establishes a string-keyed model record.
	const record = value as JsonObject;
	if (!isString(record.model) || !MODEL_ID_RE.test(record.model)) {
		return { ok: false, error: `${section}.${key}.model must be provider/model.` };
	}
	if (record.thinking !== undefined && !isThinkingLevel(record.thinking)) {
		return { ok: false, error: `${section}.${key}.thinking is not a supported thinking level.` };
	}
	const model: Exclude<PlanAdversaryModel, string> = { model: record.model };
	if (isThinkingLevel(record.thinking)) model.thinking = record.thinking;
	return { ok: true, model };
}

function configuredModel(root: JsonObject | undefined, section: string, key: string): ConfiguredModelResult {
	if (root === undefined || root[section] === undefined) return { ok: true, model: undefined };
	const sectionValue = root[section];
	if (section === "plan-adversary") {
		const validated = validatePlanAdversaryConfig(sectionValue);
		return validated.ok ? { ok: true, model: validated.config.adversary } : validated;
	}
	if (!isObject(sectionValue) || sectionValue === null || Array.isArray(sectionValue)) {
		return { ok: false, error: `${section} must be an object.` };
	}
	// SAFETY: the object guard above establishes a string-keyed section record.
	const sectionRecord = sectionValue as JsonObject;
	return genericConfiguredModel(sectionRecord[key], section, key);
}

/** Load kstack.json once, collect aliases, and resolve one skill-facing model setting. */
export function resolveConfiguredModel(request: ResolveConfiguredModelRequest): ResolveModelResult {
	const loaded = loadKstackRoot(request.env);
	if (loaded.status === "invalid") return { ok: false, error: `${loaded.path}: ${loaded.error}` };
	const root = loaded.status === "found" ? loaded.root : undefined;
	const aliases = root ? collectKstackModelAliases(root) : [];
	if (request.argument !== undefined) {
		return resolveModelRef({
			argument: request.argument,
			aliases,
			section: request.section,
			key: request.key,
		});
	}
	const configured = configuredModel(root, request.section, request.key);
	if (!configured.ok) return configured;
	return resolveModelRef({
		configured: configured.model,
		aliases,
		section: request.section,
		key: request.key,
	});
}
