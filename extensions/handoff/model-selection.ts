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

/** Canonical Pi thinking/effort levels accepted by `/handoff --model <ref>:<effort>`. */
const HANDOFF_EFFORT_LEVELS = THINKING_LEVELS;

export type HandoffEffortLevel = (typeof HANDOFF_EFFORT_LEVELS)[number];

/** Minimal structural view of a pi-ai Model, enough for resolution and setModel. */
export interface HandoffModel {
	provider: string;
	id: string;
	name?: string;
}

type HandoffParseResult = { ok: true; goal: string; modelRef?: string } | { ok: false; error: string };

type ModelResolution =
	| { status: "resolved"; model: HandoffModel; effort?: HandoffEffortLevel }
	| { status: "not-found" }
	| { status: "ambiguous"; matches: HandoffModel[] };

export function isHandoffEffortLevel(value: string): value is HandoffEffortLevel {
	return (HANDOFF_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Extract an optional `--model <ref>` (also `-m <ref>` or `--model=<ref>`)
 * from the raw command arguments. Everything else becomes the goal text.
 */
export function parseHandoffArgs(raw: string): HandoffParseResult {
	const tokens = raw.trim() === "" ? [] : raw.trim().split(/\s+/);
	let modelRef: string | undefined;
	const goalTokens: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--model" || token === "-m") {
			if (modelRef !== undefined) {
				return { ok: false, error: "handoff accepts only one --model value" };
			}
			const value = tokens[i + 1];
			if (value === undefined) {
				return {
					ok: false,
					error: "--model requires a value, e.g. /handoff --model anthropic/claude-sonnet-4-5 continue the plan",
				};
			}
			modelRef = value;
			i++;
		} else if (token.startsWith("--model=")) {
			if (modelRef !== undefined) {
				return { ok: false, error: "handoff accepts only one --model value" };
			}
			const value = token.slice("--model=".length);
			if (value === "") {
				return { ok: false, error: "--model requires a value, e.g. --model=anthropic/claude-sonnet-4-5" };
			}
			modelRef = value;
		} else {
			goalTokens.push(token);
		}
	}

	return { ok: true, goal: goalTokens.join(" "), modelRef };
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
export function resolveModelReference(models: HandoffModel[], reference: string): ModelResolution {
	const trimmed = reference.trim();
	if (trimmed === "") return { status: "not-found" };

	const full = matchModelReference(models, trimmed);
	if (full.status !== "not-found") return full;

	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon === -1) return { status: "not-found" };

	const prefix = trimmed.slice(0, lastColon).trim();
	const suffix = trimmed
		.slice(lastColon + 1)
		.trim()
		.toLowerCase();
	if (prefix === "" || !isHandoffEffortLevel(suffix)) return { status: "not-found" };

	const prefixMatch = matchModelReference(models, prefix);
	if (prefixMatch.status === "resolved") {
		return { status: "resolved", model: prefixMatch.model, effort: suffix };
	}
	return prefixMatch;
}

function matchModelReference(models: HandoffModel[], reference: string): ModelResolution {
	const lower = reference.toLowerCase();

	// 1. Canonical provider/model-id, case-insensitive.
	let matches = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	// 2. Bare model id, unique across providers.
	matches = models.filter((m) => m.id.toLowerCase() === lower);
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	// 3. For slashed references, constrain partial matching to the provider.
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

	// 4. Unique partial match on id or name across all providers.
	matches = models.filter((m) => m.id.toLowerCase().includes(lower) || (m.name ?? "").toLowerCase().includes(lower));
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	return { status: "not-found" };
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
