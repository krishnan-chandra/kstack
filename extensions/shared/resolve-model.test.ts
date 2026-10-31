import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelAlias } from "./model-aliases.ts";
import { modelWithoutThinking, resolveModelRef } from "./resolve-model.ts";

function failureMessage(result: ReturnType<typeof resolveModelRef>): string {
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected model resolution to fail");
	return result.error;
}

const aliases: ModelAlias[] = [
	{
		key: "fable",
		alias: "fable",
		modelRef: "anthropic/claude-fable-5-1",
		thinking: "high",
		source: "kstack.json",
	},
];

describe("resolveModelRef", () => {
	it("resolves a configured full reference", () => {
		assert.deepEqual(
			resolveModelRef({
				configured: "openai/gpt-5.6-astra:medium",
				aliases,
				section: "swarm",
				key: "worker",
			}),
			{ ok: true, ref: "openai/gpt-5.6-astra:medium" },
		);
	});

	it("resolves a configured alias with a thinking override", () => {
		assert.deepEqual(
			resolveModelRef({
				configured: "fable:medium",
				aliases,
				section: "swarm",
				key: "worker",
			}),
			{ ok: true, ref: "anthropic/claude-fable-5-1:medium" },
		);
	});

	it("resolves configured alias and object forms", () => {
		assert.deepEqual(resolveModelRef({ configured: "fable", aliases, section: "swarm", key: "worker" }), {
			ok: true,
			ref: "anthropic/claude-fable-5-1:high",
		});
		assert.deepEqual(
			resolveModelRef({
				configured: { model: "openai/gpt-5.6-astra", thinking: "low" },
				aliases,
				section: "swarm",
				key: "worker",
			}),
			{ ok: true, ref: "openai/gpt-5.6-astra:low" },
		);
	});

	it("reports missing, unknown, and ambiguous aliases", () => {
		assert.match(failureMessage(resolveModelRef({ aliases, section: "s", key: "k" })), /No model configured/);
		assert.match(
			failureMessage(resolveModelRef({ configured: "missing", aliases, section: "s", key: "k" })),
			/not found/,
		);
		const ambiguous = [...aliases, { ...aliases[0], modelRef: "openai/gpt-5.6-astra" }];
		assert.match(
			failureMessage(resolveModelRef({ configured: "fable", aliases: ambiguous, section: "s", key: "k" })),
			/ambiguous/,
		);
	});
});

describe("modelWithoutThinking", () => {
	it("strips only a recognized thinking suffix", () => {
		assert.equal(modelWithoutThinking("openai/gpt-6-astra:high"), "openai/gpt-6-astra");
		assert.equal(modelWithoutThinking("openai/gpt-6-astra"), "openai/gpt-6-astra");
		assert.equal(modelWithoutThinking("ollama/qwen:7b"), "ollama/qwen:7b");
	});
});
