/** Resolve model references through kstack.json aliases. */

import { type ConfiguredModel, isThinkingLevel, MODEL_ID_RE, type ModelThinkingLevel } from "./kstack-config.ts";
import { type ModelAlias, matchModelAliases } from "./model-aliases.ts";
import { isString } from "./validation.ts";

interface ResolveModelRequest {
	configured?: ConfiguredModel;
	aliases: readonly ModelAlias[];
	section: string;
	key: string;
}

type ResolveModelResult = { ok: true; ref: string } | { ok: false; error: string };

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

/** Strip a trailing `:thinking` level so models compare by provider/model only. */
export function modelWithoutThinking(reference: string): string {
	return splitThinking(reference).base;
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

/** Resolve a configured object or alias. */
export function resolveModelRef(request: ResolveModelRequest): ResolveModelResult {
	if (request.configured === undefined) {
		return {
			ok: false,
			error: `No model configured for ${request.section}.${request.key}. Set it in kstack.json.`,
		};
	}
	if (isString(request.configured)) return resolveReference(request.configured, request.aliases);
	return { ok: true, ref: withThinking(request.configured.model, request.configured.thinking) };
}
