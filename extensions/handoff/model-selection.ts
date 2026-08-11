/**
 * Argument parsing and model resolution for `/handoff --model`.
 *
 * The handoff command applies the chosen model through `pi.setModel()` before
 * calling `ctx.newSession()`. Pi resolves a brand-new session's model from the
 * configured default (settings), and `setModel` persists exactly that default,
 * so the replacement session starts on the model selected here. With no flag,
 * the handler re-applies the parent session's active model the same way, which
 * guarantees inheritance even when the configured default is stale.
 */

/** Minimal structural view of a pi-ai Model, enough for resolution and setModel. */
export interface HandoffModel {
	provider: string;
	id: string;
	name?: string;
}

export interface ParsedHandoffArgs {
	goal: string;
	modelRef?: string;
}

export type HandoffParseResult = { ok: true; goal: string; modelRef?: string } | { ok: false; error: string };

export type ModelResolution =
	| { status: "resolved"; model: HandoffModel }
	| { status: "not-found" }
	| { status: "ambiguous"; matches: HandoffModel[] };

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
 */
export function resolveModelReference(models: HandoffModel[], reference: string): ModelResolution {
	const trimmed = reference.trim();
	if (trimmed === "") return { status: "not-found" };
	const lower = trimmed.toLowerCase();

	// 1. Canonical provider/model-id, case-insensitive.
	let matches = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	// 2. Bare model id, unique across providers.
	matches = models.filter((m) => m.id.toLowerCase() === lower);
	if (matches.length === 1) return { status: "resolved", model: matches[0] };
	if (matches.length > 1) return { status: "ambiguous", matches };

	// 3. For slashed references, constrain partial matching to the provider.
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmed.slice(0, slashIndex).trim().toLowerCase();
		const pattern = trimmed.slice(slashIndex + 1).trim().toLowerCase();
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
