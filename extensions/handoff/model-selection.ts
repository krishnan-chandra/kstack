/**
 * Argument parsing and model/effort resolution for `/handoff --model`.
 *
 * The handoff command applies the chosen model through `pi.setModel()` and the
 * chosen or inherited effort through `pi.setThinkingLevel()` before calling
 * `ctx.newSession()`. Pi resolves a brand-new session's model and thinking
 * level from the configured defaults, and those setters persist exactly those
 * defaults, so in the default configuration the replacement session starts on
 * the model and effort selected here. Startup-level overrides — a `pi --model`
 * CLI flag, `--thinking`, or model scoping via `--models` / `enabledModels` —
 * take precedence over this mechanism; the handler compares the replacement
 * session's actual model and effort against the expectation and reports any
 * mismatch instead of claiming the requested ones. With no flag, the handler
 * re-applies the parent session's active model and effort the same way (best
 * effort), so inheritance holds whenever the parent's state is usable and not
 * overridden at startup.
 */
import { THINKING_LEVELS } from "../shared/kstack-config.ts";
import { type ModelAlias, matchModelAliases } from "../shared/model-aliases.ts";

/** Canonical Pi thinking/effort levels accepted by `/handoff --model <ref>:<effort>`. */
const HANDOFF_EFFORT_LEVELS = THINKING_LEVELS;
const HANDOFF_ARGUMENT_FLAGS = ["--archive", "--model", "--model=", "-m"] as const;

export type HandoffEffortLevel = (typeof HANDOFF_EFFORT_LEVELS)[number];

/** Minimal structural view of a pi-ai Model, enough for resolution and setModel. */
export interface HandoffModel {
	provider: string;
	id: string;
	name?: string;
}

type HandoffParseResult =
	| { ok: true; goal: string; modelRef?: string; archive: boolean }
	| { ok: false; error: string };

type ModelResolution =
	| { status: "resolved"; model: HandoffModel; effort?: HandoffEffortLevel }
	| { status: "not-found" }
	| { status: "ambiguous"; matches: HandoffModel[] };

type ModelMatch =
	| { status: "resolved"; model: HandoffModel; aliasThinking?: HandoffEffortLevel }
	| { status: "not-found" }
	| { status: "ambiguous"; matches: HandoffModel[] };

export function isHandoffEffortLevel(value: string): value is HandoffEffortLevel {
	return (HANDOFF_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Complete the finite part of `/handoff` arguments. Model references and goals
 * remain free-form, so Pi can safely complete flags but not their values.
 */
export function completeHandoffArgs(prefix: string): Array<{ value: string; label: string }> | null {
	let tokenStart = prefix.length;
	while (tokenStart > 0) {
		const character = prefix[tokenStart - 1];
		if (character === undefined || /\s/.test(character)) break;
		tokenStart--;
	}
	const base = prefix.slice(0, tokenStart);
	const token = prefix.slice(tokenStart);
	const previousToken = base.trimEnd().split(/\s+/).at(-1);

	// The model value is intentionally free-form. Do not offer flags while the
	// cursor is waiting for that value or while it is being entered.
	if (previousToken === "--model" || previousToken === "-m" || token.startsWith("--model=")) return null;

	const items = HANDOFF_ARGUMENT_FLAGS.filter((value) => value.startsWith(token)).map((value) => ({
		value: `${base}${value}`,
		label: value,
	}));
	return items.length > 0 ? items : null;
}

const MODEL_VALUE_HINT =
	"--model requires a value, e.g. /handoff --model anthropic/claude-sonnet-4-5 continue the plan";

/**
 * Read a `--model` value starting at tokens[index] (separate form) or from
 * `inline` (--model= form). A value opening with a double quote consumes
 * tokens until the closing quote so multi-word display names survive
 * tokenization. `nextIndex` is the first token index after the value.
 */
function readModelValue(
	tokens: string[],
	index: number,
	inline: string | undefined,
): { ok: true; value: string; nextIndex: number } | { ok: false; error: string } {
	let first = inline;
	if (first === undefined) {
		if (index >= tokens.length) return { ok: false, error: MODEL_VALUE_HINT };
		first = tokens[index];
		index++;
	}
	if (!first.startsWith('"')) {
		if (first === "") return { ok: false, error: MODEL_VALUE_HINT };
		return { ok: true, value: first, nextIndex: index };
	}
	const parts: string[] = [];
	let current = first.slice(1);
	for (;;) {
		const closing = current.indexOf('"');
		if (closing !== -1) {
			parts.push(current.slice(0, closing));
			// An effort suffix may hug the closing quote ("name":high); anything
			// else after it is almost certainly a forgotten space.
			const rest = current.slice(closing + 1);
			if (rest !== "" && !/^:[^\s"]+$/.test(rest)) {
				return { ok: false, error: "unexpected text after the closing quote in the --model value" };
			}
			const value = parts.join(" ").trim();
			if (value === "") return { ok: false, error: MODEL_VALUE_HINT };
			return { ok: true, value: `${value}${rest}`, nextIndex: index };
		}
		parts.push(current);
		if (index >= tokens.length) return { ok: false, error: "unterminated quote in the --model value" };
		current = tokens[index];
		index++;
	}
}

/**
 * Extract an optional `--model <ref>` (also `-m <ref>` or `--model=<ref>`)
 * from the raw command arguments. Double-quote the reference to use model
 * display names containing spaces (e.g. --model "Claude Sonnet 4.5").
 * Everything else becomes the goal text.
 */
export function parseHandoffArgs(raw: string): HandoffParseResult {
	const tokens = raw.trim() === "" ? [] : raw.trim().split(/\s+/);
	let modelRef: string | undefined;
	let archive = false;
	const goalTokens: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--archive") {
			if (archive) return { ok: false, error: "handoff accepts --archive only once" };
			archive = true;
		} else if (token === "--model" || token === "-m") {
			if (modelRef !== undefined) {
				return { ok: false, error: "handoff accepts only one --model value" };
			}
			const value = readModelValue(tokens, i + 1, undefined);
			if (!value.ok) return value;
			modelRef = value.value;
			i = value.nextIndex - 1;
		} else if (token.startsWith("--model=")) {
			if (modelRef !== undefined) {
				return { ok: false, error: "handoff accepts only one --model value" };
			}
			const value = readModelValue(tokens, i + 1, token.slice("--model=".length));
			if (!value.ok) return value;
			modelRef = value.value;
			i = value.nextIndex - 1;
		} else {
			goalTokens.push(token);
		}
	}

	return { ok: true, goal: goalTokens.join(" "), modelRef, archive };
}

/**
 * Resolve a user-supplied model reference against a model catalogue, mirroring
 * the matching order Pi uses for `/model`: canonical `provider/model-id`
 * first, then a unique bare model id, then unique partial matches.
 *
 * An optional `:<effort>` suffix is accepted only after the full reference
 * fails to match. That preserves model IDs that themselves contain colons
 * (OpenRouter `:exacto`, Ollama tags, etc.). Invalid suffixes stay part of
 * the model reference rather than being silently dropped.
 */
/**
 * `aliases` are shared short names (kstack.json labels and model display
 * names; see shared/model-aliases.ts). They match exactly after
 * normalization, ranked after canonical and bare-id references but before
 * partial matching. An alias target that is absent from `models` (for
 * example a kstack.json label pointing outside the scoped models) resolves
 * as not-found.
 */
export function resolveModelReference(
	models: HandoffModel[],
	reference: string,
	aliases: readonly ModelAlias[] = [],
): ModelResolution {
	const trimmed = reference.trim();
	if (trimmed === "") return { status: "not-found" };

	const full = matchModelReference(models, trimmed, aliases);
	if (full.status === "resolved") {
		return full.aliasThinking === undefined
			? { status: "resolved", model: full.model }
			: { status: "resolved", model: full.model, effort: full.aliasThinking };
	}
	if (full.status !== "not-found") return full;

	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon === -1) return { status: "not-found" };

	const prefix = trimmed.slice(0, lastColon).trim();
	const suffix = trimmed
		.slice(lastColon + 1)
		.trim()
		.toLowerCase();
	if (prefix === "" || !isHandoffEffortLevel(suffix)) return { status: "not-found" };

	const prefixMatch = matchModelReference(models, prefix, aliases);
	if (prefixMatch.status === "resolved") {
		// An explicit effort suffix always wins over the alias's configured level.
		return { status: "resolved", model: prefixMatch.model, effort: suffix };
	}
	return prefixMatch;
}

function matchModelReference(models: HandoffModel[], reference: string, aliases: readonly ModelAlias[]): ModelMatch {
	const lower = reference.toLowerCase();

	// 1. Canonical provider/model-id, case-insensitive.
	let matches = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	// 2. Bare model id, unique across providers.
	matches = models.filter((m) => m.id.toLowerCase() === lower);
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	// 3. Exact alias short name (kstack.json label or model display name).
	const aliasMatches = matchModelAliases(aliases, reference);
	if (aliasMatches.length > 0) {
		const targets = new Map<string, { model: HandoffModel; thinking?: HandoffEffortLevel }>();
		for (const alias of aliasMatches) {
			const target = exactModelLookup(models, alias.modelRef);
			if (target) {
				const key = `${target.provider}/${target.id}`.toLowerCase();
				if (!targets.has(key)) targets.set(key, { model: target, thinking: alias.thinking });
			}
		}
		if (targets.size === 1) {
			const [{ model, thinking }] = targets.values();
			return { status: "resolved", model, aliasThinking: thinking };
		}
		if (targets.size > 1) return { status: "ambiguous", matches: [...targets.values()].map((t) => t.model) };
		// An alias claimed this reference but its target is unavailable.
		return { status: "not-found" };
	}

	// 4. For slashed references, constrain partial matching to the provider.
	const slashIndex = reference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = reference.slice(0, slashIndex).trim().toLowerCase();
		const pattern = reference
			.slice(slashIndex + 1)
			.trim()
			.toLowerCase();
		if (provider !== "" && pattern !== "") {
			const providerModels = models.filter((m) => m.provider.toLowerCase() === provider);
			matches = providerModels.filter(
				(m) => m.id.toLowerCase().includes(pattern) || (m.name ?? "").toLowerCase().includes(pattern),
			);
			if (matches.length === 1) return { status: "resolved", model: matches[0] };
			if (matches.length > 1) return { status: "ambiguous", matches };
			return { status: "not-found" };
		}
	}

	// 5. Unique partial match on id or name across all providers.
	matches = models.filter((m) => m.id.toLowerCase().includes(lower) || (m.name ?? "").toLowerCase().includes(lower));
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	return { status: "not-found" };
}

/** Exact lookup for an alias target: canonical provider/model-id, then unique bare id. */
function exactModelLookup(models: HandoffModel[], modelRef: string): HandoffModel | undefined {
	const lower = modelRef.trim().toLowerCase();
	const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
	if (canonical.length === 1) return canonical[0];
	const bare = models.filter((m) => m.id.toLowerCase() === lower);
	if (bare.length === 1) return bare[0];
	return undefined;
}

/** Format a model as the canonical `provider/model-id` reference. */
export function formatModelRef(model: HandoffModel): string {
	return `${model.provider}/${model.id}`;
}

/** Format a model plus optional effort as `provider/model-id` or `provider/model-id:effort`. */
export function formatModelEffort(model: HandoffModel, effort?: string): string {
	const ref = formatModelRef(model);
	return effort ? `${ref}:${effort}` : ref;
}

interface ThinkingLevelApi {
	getThinkingLevel(): string;
	setThinkingLevel(level: HandoffEffortLevel): void;
}

/**
 * Apply `desired` through Pi's thinking-level setter and return the effective
 * post-clamp value.
 *
 * Pi only persists an effort when the effective level changes. Setting the
 * already-active parent level is therefore a no-op and would leave a stale
 * settings default for the replacement session. When the current effective
 * level already matches `desired`, briefly bounce through another supported
 * level and restore `desired` so the default is written. A model that exposes
 * only one effective level cannot persist a change; fresh-session clamping
 * already guarantees that level.
 */
export function pinHandoffEffort(api: ThinkingLevelApi, desired: HandoffEffortLevel): HandoffEffortLevel {
	const before = api.getThinkingLevel();
	api.setThinkingLevel(desired);
	const after = api.getThinkingLevel();
	if (before === after && after === desired) {
		for (const candidate of HANDOFF_EFFORT_LEVELS) {
			if (candidate === desired) continue;
			api.setThinkingLevel(candidate);
			if (api.getThinkingLevel() !== desired) {
				api.setThinkingLevel(desired);
				break;
			}
		}
	}
	const effective = api.getThinkingLevel();
	return isHandoffEffortLevel(effective) ? effective : desired;
}
