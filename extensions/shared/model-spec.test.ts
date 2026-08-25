import assert from "node:assert/strict";
import test from "node:test";
import { modelCliId, splitModelRef, validateModelSpecFields } from "./model-spec.ts";
import type { BoundaryValue } from "./validation.ts";

test("formats a model id without a thinking level", () => {
	assert.equal(modelCliId({ model: "anthropic/claude-opus-4-6" }), "anthropic/claude-opus-4-6");
});

test("appends the configured thinking level", () => {
	assert.equal(modelCliId({ model: "openai/gpt-5.6-terra", thinking: "medium" }), "openai/gpt-5.6-terra:medium");
});

test("preserves extra model-id path segments", () => {
	assert.equal(
		modelCliId({ model: "openrouter/deepseek/deepseek-v4-pro", thinking: "high" }),
		"openrouter/deepseek/deepseek-v4-pro:high",
	);
	assert.deepEqual(splitModelRef("openrouter/deepseek/deepseek-v4-pro"), {
		provider: "openrouter",
		modelId: "deepseek/deepseek-v4-pro",
	});
});

const errors = {
	label: (value: BoundaryValue) => `label:${String(value)}`,
	model: (value: BoundaryValue) => `model:${String(value)}`,
	thinking: (value: BoundaryValue) => `thinking:${String(value)}`,
};

test("validates required labels and provider/model ids", () => {
	assert.deepEqual(
		validateModelSpecFields(
			{ label: "reviewer_1", model: "openrouter/deepseek/deepseek-v4-pro" },
			{ requireLabel: true, errors },
		),
		{ ok: true, label: "reviewer_1", model: "openrouter/deepseek/deepseek-v4-pro" },
	);
	assert.deepEqual(validateModelSpecFields({ label: "bad label", model: "p/m" }, { requireLabel: true, errors }), {
		ok: false,
		error: "label:bad label",
	});
	assert.deepEqual(validateModelSpecFields({ label: "good", model: "missing-slash" }, { requireLabel: true, errors }), {
		ok: false,
		error: "model:missing-slash",
	});
});

test("enforces a caller-provided thinking subset", () => {
	assert.deepEqual(
		validateModelSpecFields(
			{ model: "p/m", thinking: "low" },
			{ requireLabel: false, allowedThinking: ["off", "low"], errors },
		),
		{ ok: true, model: "p/m", thinking: "low" },
	);
	assert.deepEqual(
		validateModelSpecFields(
			{ model: "p/m", thinking: "high" },
			{ requireLabel: false, allowedThinking: ["off", "low"], errors },
		),
		{ ok: false, error: "thinking:high" },
	);
});
