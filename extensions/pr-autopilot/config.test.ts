import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_AUTOPILOT_MODELS, loadConfig, modelCliId, resolveModels, validateConfig } from "./config.ts";

describe("pr-autopilot config", () => {
	it("defaults to three models", () => {
		assert.equal(DEFAULT_AUTOPILOT_MODELS.length, 3);
		assert.equal(DEFAULT_AUTOPILOT_MODELS[0].model, "openai/gpt-5.6-luna");
		assert.equal(DEFAULT_AUTOPILOT_MODELS[1].model, "openrouter/z-ai/glm-5.2");
		assert.equal(DEFAULT_AUTOPILOT_MODELS[2].model, "openrouter/deepseek/deepseek-v4-flash");
		for (const m of DEFAULT_AUTOPILOT_MODELS) {
			assert.equal(m.thinking, "low");
		}
	});

	it("validates a well-formed model config", () => {
		const result = validateConfig({
			models: [
				{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
				{ label: "lite", model: "openrouter/z-ai/glm-5.2" },
			],
			maxConcurrency: 2,
			timeoutMinutes: 5,
			maxRuntimeMinutes: 15,
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.config.models[0].thinking, "low");
			// Missing thinking defaults to "low".
			assert.equal(result.config.models[1].thinking, "low");
			assert.equal(result.config.maxConcurrency, 2);
			assert.equal(result.config.timeoutMinutes, 5);
			assert.equal(result.config.maxRuntimeMinutes, 15);
		}
	});

	it("accepts any supported thinking level", () => {
		const result = validateConfig({
			models: [
				{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "max" },
				{ label: "lite", model: "openrouter/z-ai/glm-5.2", thinking: "high" },
			],
		});
		assert.equal(result.ok, true);
		if (result.ok)
			assert.deepEqual(
				result.config.models.map((model) => model.thinking),
				["max", "high"],
			);
	});

	it("requires at least 2 models", () => {
		const result = validateConfig({
			models: [{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" }],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /at least 2/);
	});

	it("rejects duplicate labels and models", () => {
		const base = { thinking: "low" };
		assert.match(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (
				validateConfig({
					models: [
						{ ...base, label: "a", model: "openai/m1" },
						{ ...base, label: "a", model: "openai/m2" },
					],
				}) as { error: string }
			).error,
			/Duplicate model label/,
		);
		assert.match(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (
				validateConfig({
					models: [
						{ ...base, label: "a", model: "openai/m1" },
						{ ...base, label: "b", model: "openai/m1" },
					],
				}) as { error: string }
			).error,
			/Duplicate model/,
		);
	});

	it("rejects invalid model ids, timeouts, and concurrency", () => {
		const base = { thinking: "low" };
		assert.match(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (
				validateConfig({
					models: [
						{ ...base, label: "a", model: "bad" },
						{ ...base, label: "b", model: "openai/m2" },
					],
				}) as { error: string }
			).error,
			/provider\/model/,
		);
		assert.match(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (
				validateConfig({
					models: [
						{ ...base, label: "a", model: "openai/m1" },
						{ ...base, label: "b", model: "openai/m2" },
					],
					timeoutMinutes: 0,
				}) as { error: string }
			).error,
			/between 1 and 15/,
		);
		assert.match(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (
				validateConfig({
					models: [
						{ ...base, label: "a", model: "openai/m1" },
						{ ...base, label: "b", model: "openai/m2" },
					],
					maxConcurrency: 0,
				}) as { error: string }
			).error,
			/between 1 and 5/,
		);
		assert.match(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ (
				validateConfig({
					models: [
						{ ...base, label: "a", model: "openai/m1" },
						{ ...base, label: "b", model: "openai/m2" },
					],
					maxRuntimeMinutes: 1,
				}) as { error: string }
			).error,
			/between 2 and 60/,
		);
	});

	it("trusts explicitly configured model IDs even when absent from Pi's registry", () => {
		const valid = validateConfig({
			models: [
				{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
				{ label: "lite", model: "openrouter/z-ai/glm-5.2", thinking: "low" },
			],
		});
		assert.equal(valid.ok, true);
		if (!valid.ok) return;

		const result = resolveModels({
			status: "loaded",
			config: { ...valid.config, source: "config", warnings: [] },
			path: "/fake",
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.config.source, "config");
			assert.deepEqual(result.config.models, valid.config.models);
		}
	});

	it("uses the complete default set without consulting model availability", () => {
		const result = resolveModels({ status: "missing", path: "/fake" });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.config.source, "default");
			assert.deepEqual(result.config.models, DEFAULT_AUTOPILOT_MODELS);
			assert.deepEqual(result.config.warnings, []);
		}
	});

	it("formats CLI model ids", () => {
		assert.equal(modelCliId({ label: "x", model: "a/b", thinking: "low" }), "a/b:low");
		assert.equal(modelCliId({ label: "x", model: "a/b" }), "a/b");
	});

	it("loads only the pr-autopilot section from unified kstack.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pr-autopilot-config-"));
		try {
			writeFileSync(
				join(dir, "kstack.json"),
				JSON.stringify({
					"panel-review": { reviewers: [] },
					"pr-autopilot": {
						models: [
							{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
							{ label: "lite", model: "openrouter/z-ai/glm-5.2", thinking: "low" },
						],
					},
				}),
			);
			const result = loadConfig({ PI_CODING_AGENT_DIR: dir });
			assert.equal(result.status, "loaded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
