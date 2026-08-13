import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	formatModelRef,
	isHandoffEffortLevel,
	parseHandoffArgs,
	resolveModelReference,
	type HandoffEffortLevel,
	type HandoffModel,
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

describe("parseHandoffArgs", () => {
	it("returns the goal untouched when no model flag is present", () => {
		assert.deepEqual(parseHandoffArgs("  implement teams support  "), {
			ok: true,
			goal: "implement teams support",
			modelRef: undefined,
		});
	});

	it("handles empty input", () => {
		assert.deepEqual(parseHandoffArgs("   "), { ok: true, goal: "", modelRef: undefined });
	});

	it("extracts --model before the goal", () => {
		assert.deepEqual(parseHandoffArgs("--model anthropic/claude-opus-4-6 execute phase one"), {
			ok: true,
			goal: "execute phase one",
			modelRef: "anthropic/claude-opus-4-6",
		});
	});

	it("extracts --model after the goal", () => {
		assert.deepEqual(parseHandoffArgs("execute phase one --model openai/gpt-5.2"), {
			ok: true,
			goal: "execute phase one",
			modelRef: "openai/gpt-5.2",
		});
	});

	it("extracts the -m short form", () => {
		assert.deepEqual(parseHandoffArgs("-m google/gemini-3-pro continue"), {
			ok: true,
			goal: "continue",
			modelRef: "google/gemini-3-pro",
		});
	});

	it("extracts the --model=value form", () => {
		assert.deepEqual(parseHandoffArgs("--model=google/gemini-3-pro continue"), {
			ok: true,
			goal: "continue",
			modelRef: "google/gemini-3-pro",
		});
	});

	it("extracts --model=provider/model:high without interpreting the suffix", () => {
		assert.deepEqual(parseHandoffArgs("--model=openai/gpt-5.2:high continue the work"), {
			ok: true,
			goal: "continue the work",
			modelRef: "openai/gpt-5.2:high",
		});
	});

	it("extracts -m provider/model:max without interpreting the suffix", () => {
		assert.deepEqual(parseHandoffArgs("-m anthropic/claude-opus-4-6:max finish the refactor"), {
			ok: true,
			goal: "finish the refactor",
			modelRef: "anthropic/claude-opus-4-6:max",
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
