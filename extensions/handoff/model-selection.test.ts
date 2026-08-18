import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelAlias } from "../shared/model-aliases.ts";
import {
	completeHandoffArgs,
	formatModelEffort,
	formatModelRef,
	type HandoffEffortLevel,
	type HandoffModel,
	isHandoffEffortLevel,
	parseHandoffArgs,
	pinHandoffEffort,
	resolveModelReference,
} from "./model-selection.ts";

const MODELS: HandoffModel[] = [
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
	{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
	{ provider: "openai", id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
	{ provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro" },
	{ provider: "openrouter", id: "qwen/qwen3-coder:exacto", name: "Qwen3 Coder Exacto" },
	{ provider: "ollama", id: "llama3:70b", name: "Llama 3 70B" },
];

const ALL_EFFORTS: HandoffEffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

describe("completeHandoffArgs", () => {
	it("completes handoff flags at the start of the arguments", () => {
		assert.deepEqual(completeHandoffArgs(""), [
			{ value: "--archive", label: "--archive" },
			{ value: "--model", label: "--model" },
			{ value: "--model=", label: "--model=" },
			{ value: "-m", label: "-m" },
		]);
		assert.deepEqual(completeHandoffArgs("--"), [
			{ value: "--archive", label: "--archive" },
			{ value: "--model", label: "--model" },
			{ value: "--model=", label: "--model=" },
		]);
		assert.ok(completeHandoffArgs("-")?.some((item) => item.value === "-m"));
	});

	it("preserves a goal while completing a later flag", () => {
		assert.deepEqual(completeHandoffArgs("continue the work --a"), [
			{ value: "continue the work --archive", label: "--archive" },
		]);
	});

	it("does not suggest flags while entering a model value", () => {
		assert.equal(completeHandoffArgs("--model "), null);
		assert.equal(completeHandoffArgs("--model anthropic/claude"), null);
	});
});

describe("parseHandoffArgs", () => {
	it("returns the goal untouched when no model flag is present", () => {
		assert.deepEqual(parseHandoffArgs("  implement teams support  "), {
			ok: true,
			goal: "implement teams support",
			modelRef: undefined,
			archive: false,
		});
	});

	it("handles empty input", () => {
		assert.deepEqual(parseHandoffArgs("   "), { ok: true, goal: "", modelRef: undefined, archive: false });
	});

	it("extracts the opt-in archive flag", () => {
		assert.deepEqual(parseHandoffArgs("--archive continue the work"), {
			ok: true,
			goal: "continue the work",
			modelRef: undefined,
			archive: true,
		});
	});

	it("extracts --model before the goal", () => {
		assert.deepEqual(parseHandoffArgs("--model anthropic/claude-opus-4-6 execute phase one"), {
			ok: true,
			goal: "execute phase one",
			modelRef: "anthropic/claude-opus-4-6",
			archive: false,
		});
	});

	it("extracts --model after the goal", () => {
		assert.deepEqual(parseHandoffArgs("execute phase one --model openai/gpt-5.2"), {
			ok: true,
			goal: "execute phase one",
			modelRef: "openai/gpt-5.2",
			archive: false,
		});
	});

	it("extracts the -m short form", () => {
		assert.deepEqual(parseHandoffArgs("-m google/gemini-3-pro continue"), {
			ok: true,
			goal: "continue",
			modelRef: "google/gemini-3-pro",
			archive: false,
		});
	});

	it("extracts the --model=value form", () => {
		assert.deepEqual(parseHandoffArgs("--model=google/gemini-3-pro continue"), {
			ok: true,
			goal: "continue",
			modelRef: "google/gemini-3-pro",
			archive: false,
		});
	});

	it("extracts --model=provider/model:high without interpreting the suffix", () => {
		assert.deepEqual(parseHandoffArgs("--model=openai/gpt-5.2:high continue the work"), {
			ok: true,
			goal: "continue the work",
			modelRef: "openai/gpt-5.2:high",
			archive: false,
		});
	});

	it("extracts -m provider/model:max without interpreting the suffix", () => {
		assert.deepEqual(parseHandoffArgs("-m anthropic/claude-opus-4-6:max finish the refactor"), {
			ok: true,
			goal: "finish the refactor",
			modelRef: "anthropic/claude-opus-4-6:max",
			archive: false,
		});
	});

	it("errors when the flag has no value", () => {
		const result = parseHandoffArgs("goal --model");
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("--model requires a value"));
	});

	it("errors when --model= has an empty value", () => {
		const result = parseHandoffArgs("--model= goal");
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("--model requires a value"));
	});

	it("errors on duplicate model flags", () => {
		const result = parseHandoffArgs("--model openai/gpt-5.2 -m google/gemini-3-pro goal");
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("only one --model"));
	});

	it("extracts a quoted multi-word display name", () => {
		assert.deepEqual(parseHandoffArgs('--model "Claude Sonnet 4.5" continue the work'), {
			ok: true,
			goal: "continue the work",
			modelRef: "Claude Sonnet 4.5",
			archive: false,
		});
	});

	it("extracts a quoted multi-word display name in --model= form", () => {
		assert.deepEqual(parseHandoffArgs('goal --model="Claude Sonnet 4.5" more goal'), {
			ok: true,
			goal: "goal more goal",
			modelRef: "Claude Sonnet 4.5",
			archive: false,
		});
	});

	it("keeps an effort suffix outside the quotes", () => {
		const result = parseHandoffArgs('--model "Qwen3 Coder Exacto":high goal');
		assert.deepEqual(result, { ok: true, goal: "goal", modelRef: "Qwen3 Coder Exacto:high", archive: false });
	});

	it("errors on an unterminated quote", () => {
		const result = parseHandoffArgs('--model "Claude Sonnet goal');
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("unterminated quote"));
	});

	it("errors on text after the closing quote", () => {
		const result = parseHandoffArgs('--model "Claude Sonnet 4.5"extra goal');
		assert.equal(result.ok, false);
		if (!result.ok) assert.ok(result.error.includes("closing quote"));
	});
});

describe("resolveModelReference", () => {
	it("resolves a canonical provider/model-id exactly", () => {
		const result = resolveModelReference(MODELS, "anthropic/claude-sonnet-4-5");
		assert.deepEqual(result, { status: "resolved", model: MODELS[0] });
	});

	it("resolves case-insensitively", () => {
		const result = resolveModelReference(MODELS, "OpenAI/GPT-5.2");
		assert.deepEqual(result, { status: "resolved", model: MODELS[2] });
	});

	it("resolves a unique bare model id", () => {
		const result = resolveModelReference(MODELS, "gpt-5.2");
		assert.deepEqual(result, { status: "resolved", model: MODELS[2] });
	});

	it("reports ambiguity for a bare id shared across providers", () => {
		const dupes: HandoffModel[] = [
			{ provider: "a", id: "small", name: "Small A" },
			{ provider: "b", id: "small", name: "Small B" },
		];
		const result = resolveModelReference(dupes, "small");
		assert.equal(result.status, "ambiguous");
		if (result.status === "ambiguous") assert.equal(result.matches.length, 2);
	});

	it("resolves a provider-scoped partial id", () => {
		const result = resolveModelReference(MODELS, "anthropic/sonnet");
		assert.deepEqual(result, { status: "resolved", model: MODELS[0] });
	});

	it("resolves a provider-scoped partial name", () => {
		const result = resolveModelReference(MODELS, "google/gemini");
		assert.deepEqual(result, { status: "resolved", model: MODELS[4] });
	});

	it("reports ambiguity for a provider-scoped partial with several matches", () => {
		const result = resolveModelReference(MODELS, "anthropic/claude");
		assert.equal(result.status, "ambiguous");
		if (result.status === "ambiguous") assert.equal(result.matches.length, 2);
	});

	it("does not leak partial matches across providers for slashed references", () => {
		const result = resolveModelReference(MODELS, "google/claude");
		assert.deepEqual(result, { status: "not-found" });
	});

	it("resolves a unique global partial match", () => {
		const result = resolveModelReference(MODELS, "codex");
		assert.deepEqual(result, { status: "resolved", model: MODELS[3] });
	});

	it("reports ambiguity for a global partial with several matches", () => {
		const result = resolveModelReference(MODELS, "gpt");
		assert.equal(result.status, "ambiguous");
		if (result.status === "ambiguous") {
			assert.deepEqual(
				result.matches.map((m) => m.id),
				["gpt-5.2", "gpt-5.2-codex"],
			);
		}
	});

	it("returns not-found for unknown references", () => {
		assert.deepEqual(resolveModelReference(MODELS, "nope/xyz"), { status: "not-found" });
		assert.deepEqual(resolveModelReference(MODELS, "does-not-exist"), { status: "not-found" });
		assert.deepEqual(resolveModelReference(MODELS, "   "), { status: "not-found" });
		assert.deepEqual(resolveModelReference([], "anthropic/claude-sonnet-4-5"), { status: "not-found" });
	});

	it("returns no explicit effort when the reference has no suffix", () => {
		const result = resolveModelReference(MODELS, "anthropic/claude-sonnet-4-5");
		assert.deepEqual(result, { status: "resolved", model: MODELS[0] });
		if (result.status === "resolved") assert.equal(result.effort, undefined);
	});

	it("resolves a canonical model with each valid effort suffix", () => {
		for (const effort of ALL_EFFORTS) {
			const result = resolveModelReference(MODELS, `openai/gpt-5.2:${effort}`);
			assert.deepEqual(result, { status: "resolved", model: MODELS[2], effort }, effort);
		}
	});

	it("resolves a unique partial model with a representative effort", () => {
		const result = resolveModelReference(MODELS, "codex:max");
		assert.deepEqual(result, { status: "resolved", model: MODELS[3], effort: "max" });
	});

	it("resolves a provider-scoped partial with an effort suffix", () => {
		const result = resolveModelReference(MODELS, "anthropic/sonnet:high");
		assert.deepEqual(result, { status: "resolved", model: MODELS[0], effort: "high" });
	});

	it("prefers a full model id that already ends in a colon-bearing suffix", () => {
		const result = resolveModelReference(MODELS, "openrouter/qwen/qwen3-coder:exacto");
		assert.deepEqual(result, { status: "resolved", model: MODELS[5] });
		if (result.status === "resolved") assert.equal(result.effort, undefined);
	});

	it("still attaches effort after a colon-bearing model id", () => {
		const result = resolveModelReference(MODELS, "openrouter/qwen/qwen3-coder:exacto:high");
		assert.deepEqual(result, { status: "resolved", model: MODELS[5], effort: "high" });
	});

	it("resolves a colon-bearing bare model id before treating the suffix as effort", () => {
		const result = resolveModelReference(MODELS, "llama3:70b");
		assert.deepEqual(result, { status: "resolved", model: MODELS[6] });
		if (result.status === "resolved") assert.equal(result.effort, undefined);
	});

	it("attaches effort to a colon-bearing bare model id", () => {
		const result = resolveModelReference(MODELS, "llama3:70b:medium");
		assert.deepEqual(result, { status: "resolved", model: MODELS[6], effort: "medium" });
	});

	it("keeps a valid effort suffix with an unknown model as not-found", () => {
		assert.deepEqual(resolveModelReference(MODELS, "nope/does-not-exist:high"), { status: "not-found" });
	});

	it("keeps a valid effort suffix with an ambiguous model prefix", () => {
		const result = resolveModelReference(MODELS, "gpt:high");
		assert.equal(result.status, "ambiguous");
		if (result.status === "ambiguous") {
			assert.deepEqual(
				result.matches.map((m) => m.id),
				["gpt-5.2", "gpt-5.2-codex"],
			);
		}
	});

	it("treats an invalid suffix as part of an unknown model reference", () => {
		assert.deepEqual(resolveModelReference(MODELS, "openai/gpt-5.2:turbo"), { status: "not-found" });
		assert.deepEqual(resolveModelReference(MODELS, "openai/gpt-5.2:"), { status: "not-found" });
	});
});

describe("resolveModelReference with aliases", () => {
	const ALIASES: ModelAlias[] = [
		{ key: "terra", alias: "terra", modelRef: "openai/gpt-5.2", thinking: "max", source: "kstack.json" },
		{
			key: "claude sonnet 4.5",
			alias: "Claude Sonnet 4.5",
			modelRef: "anthropic/claude-sonnet-4-5",
			source: "model name",
		},
		{
			key: "claude-sonnet-4.5",
			alias: "Claude Sonnet 4.5",
			modelRef: "anthropic/claude-sonnet-4-5",
			source: "model name",
		},
	];

	it("resolves a kstack.json label with its configured thinking level", () => {
		const result = resolveModelReference(MODELS, "terra", ALIASES);
		assert.deepEqual(result, { status: "resolved", model: MODELS[2], effort: "max" });
	});

	it("lets an explicit effort suffix override the alias thinking level", () => {
		const result = resolveModelReference(MODELS, "terra:low", ALIASES);
		assert.deepEqual(result, { status: "resolved", model: MODELS[2], effort: "low" });
	});

	it("resolves a display name by normalized and slug forms", () => {
		assert.deepEqual(resolveModelReference(MODELS, "Claude Sonnet 4.5", ALIASES), {
			status: "resolved",
			model: MODELS[0],
		});
		assert.deepEqual(resolveModelReference(MODELS, "claude-sonnet-4.5", ALIASES), {
			status: "resolved",
			model: MODELS[0],
		});
	});

	it("prefers a canonical or bare-id reference over an alias", () => {
		const colliding: ModelAlias[] = [
			{ key: "gpt-5.2", alias: "gpt-5.2", modelRef: "anthropic/claude-opus-4-6", source: "kstack.json" },
		];
		const result = resolveModelReference(MODELS, "gpt-5.2", colliding);
		assert.deepEqual(result, { status: "resolved", model: MODELS[2] });
	});

	it("prefers an alias over partial matching", () => {
		const codexAlias: ModelAlias[] = [
			{ key: "gpt", alias: "gpt", modelRef: "openai/gpt-5.2-codex", source: "kstack.json" },
		];
		const result = resolveModelReference(MODELS, "gpt", codexAlias);
		assert.deepEqual(result, { status: "resolved", model: MODELS[3] });
	});

	it("reports not-found when the alias target is outside the catalogue", () => {
		const scoped = [MODELS[0]];
		assert.deepEqual(resolveModelReference(scoped, "terra", ALIASES), { status: "not-found" });
	});

	it("reports ambiguity when aliases map one name to different models", () => {
		const dupes: ModelAlias[] = [
			{ key: "fast", alias: "fast", modelRef: "openai/gpt-5.2", source: "kstack.json" },
			{ key: "fast", alias: "GPT-5.2 Codex", modelRef: "openai/gpt-5.2-codex", source: "model name" },
		];
		const result = resolveModelReference(MODELS, "fast", dupes);
		assert.equal(result.status, "ambiguous");
		if (result.status === "ambiguous") assert.equal(result.matches.length, 2);
	});

	it("dedupes aliases from two sources pointing at the same model", () => {
		const dupes: ModelAlias[] = [
			{ key: "sonnet", alias: "sonnet", modelRef: "anthropic/claude-sonnet-4-5", source: "kstack.json" },
			{ key: "sonnet", alias: "Sonnet", modelRef: "claude-sonnet-4-5", source: "model name" },
		];
		const result = resolveModelReference(MODELS, "sonnet", dupes);
		assert.equal(result.status, "resolved");
	});
});

describe("isHandoffEffortLevel", () => {
	it("accepts every canonical Pi thinking level", () => {
		for (const effort of ALL_EFFORTS) {
			assert.equal(isHandoffEffortLevel(effort), true, effort);
		}
	});

	it("rejects unknown suffixes", () => {
		assert.equal(isHandoffEffortLevel("turbo"), false);
		assert.equal(isHandoffEffortLevel("HIGH"), false);
	});
});

describe("formatModelRef", () => {
	it("formats the canonical reference", () => {
		assert.equal(formatModelRef(MODELS[0]), "anthropic/claude-sonnet-4-5");
	});
});

describe("formatModelEffort", () => {
	it("omits the suffix when effort is absent", () => {
		assert.equal(formatModelEffort(MODELS[0]), "anthropic/claude-sonnet-4-5");
	});

	it("appends the effort suffix when present", () => {
		assert.equal(formatModelEffort(MODELS[0], "high"), "anthropic/claude-sonnet-4-5:high");
	});
});

describe("pinHandoffEffort", () => {
	function makeThinkingApi(initial: string, available: string[] = ALL_EFFORTS) {
		let current = initial;
		const sets: string[] = [];
		return {
			api: {
				getThinkingLevel: () => current,
				setThinkingLevel: (level: HandoffEffortLevel) => {
					sets.push(level);
					current = available.includes(level) ? level : (available.at(-1) ?? "off");
				},
			},
			sets,
			get current() {
				return current;
			},
		};
	}

	it("sets a different effort once and returns the effective level", () => {
		const { api, sets } = makeThinkingApi("medium");
		assert.equal(pinHandoffEffort(api, "high"), "high");
		assert.deepEqual(sets, ["high"]);
	});

	it("round-trips through another level when the desired effort is already current", () => {
		const { api, sets } = makeThinkingApi("high");
		assert.equal(pinHandoffEffort(api, "high"), "high");
		assert.deepEqual(sets, ["high", "off", "high"]);
	});

	it("returns the clamped level without bouncing when the request is unsupported", () => {
		const { api, sets } = makeThinkingApi("high", ["low", "medium", "high"]);
		assert.equal(pinHandoffEffort(api, "max"), "high");
		assert.deepEqual(sets, ["max"]);
	});

	it("skips the bounce when the model exposes only one effective level", () => {
		const { api, sets } = makeThinkingApi("off", ["off"]);
		assert.equal(pinHandoffEffort(api, "off"), "off");
		assert.ok(sets.includes("off"));
		assert.equal(api.getThinkingLevel(), "off");
	});
});
