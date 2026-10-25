import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelAlias } from "./model-aliases.ts";
import { modelWithoutThinking, resolveConfiguredModel, resolveModelRef } from "./resolve-model.ts";

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
	it("gives an explicit full reference precedence over configuration", () => {
		assert.deepEqual(
			resolveModelRef({
				argument: "openai/gpt-5.6-astra:medium",
				configured: "fable",
				aliases,
				section: "swarm",
				key: "worker",
			}),
			{ ok: true, ref: "openai/gpt-5.6-astra:medium" },
		);
	});

	it("resolves an explicit alias with a thinking override", () => {
		assert.deepEqual(
			resolveModelRef({
				argument: "fable:medium",
				aliases,
				section: "swarm",
				key: "worker",
			}),
			{ ok: true, ref: "anthropic/claude-fable-5-1:medium" },
		);
	});

	it("falls back to configured alias and object forms", () => {
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
			failureMessage(resolveModelRef({ argument: "missing", aliases, section: "s", key: "k" })),
			/not found/,
		);
		const ambiguous = [...aliases, { ...aliases[0], modelRef: "openai/gpt-5.6-astra" }];
		assert.match(
			failureMessage(resolveModelRef({ argument: "fable", aliases: ambiguous, section: "s", key: "k" })),
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

describe("resolveConfiguredModel", () => {
	it("resolves a configured alias through kstack.json aliases", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-resolve-model-"));
		writeFileSync(
			join(dir, "kstack.json"),
			JSON.stringify({
				aliases: [{ label: "fable", model: "anthropic/claude-fable-5-1", thinking: "high" }],
				swarm: { worker: "fable", maxConcurrency: 4 },
			}),
		);
		assert.deepEqual(
			resolveConfiguredModel({
				section: "swarm",
				key: "worker",
				env: { PI_CODING_AGENT_DIR: dir },
			}),
			{ ok: true, ref: "anthropic/claude-fable-5-1:high" },
		);
	});

	it("supports generic model-valued sections for later fanout skills", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-resolve-model-generic-"));
		writeFileSync(
			join(dir, "kstack.json"),
			JSON.stringify({ arena: { crossJudge: { model: "openai/gpt-5.6-astra", thinking: "high" } } }),
		);
		assert.deepEqual(
			resolveConfiguredModel({ section: "arena", key: "crossJudge", env: { PI_CODING_AGENT_DIR: dir } }),
			{ ok: true, ref: "openai/gpt-5.6-astra:high" },
		);
	});

	it("allows an explicit full reference without a config file", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-resolve-model-missing-"));
		assert.deepEqual(
			resolveConfiguredModel({
				argument: "openai/gpt-5.6-astra:medium",
				section: "swarm",
				key: "worker",
				env: { PI_CODING_AGENT_DIR: dir },
			}),
			{ ok: true, ref: "openai/gpt-5.6-astra:medium" },
		);
	});
});
