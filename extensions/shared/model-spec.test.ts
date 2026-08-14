import assert from "node:assert/strict";
import test from "node:test";
import { modelCliId } from "./model-spec.ts";

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
});
