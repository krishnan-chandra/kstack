import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_TINY_MODELS, loadConfig, modelCliId, resolveModels, validateConfig } from "./config.ts";

describe("pr-autopilot config", () => {
	it("defaults to the three tiny models", () => {
		assert.equal(DEFAULT_TINY_MODELS.length, 3);
		assert.equal(DEFAULT_TINY_MODELS[0].model, "openai/gpt-5.6-luna");
		assert.equal(DEFAULT_TINY_MODELS[1].model, "google-vertex/gemini-3.7-flash");
		assert.equal(DEFAULT_TINY_MODELS[2].model, "openrouter/deepseek/deepseek-v4-flash");
		for (const m of DEFAULT_TINY_MODELS) {
			assert.equal(m.thinking, "low");
		}
	});

	it("validates a well-formed tiny-model config", () => {
		const result = validateConfig({
			models: [
				{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
				{ label: "lite", model: "google-vertex/gemini-3.7-flash" },
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

	it("rejects thinking above low — tiny-model invariant", () => {
		const result = validateConfig({
			models: [
				{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "high" },
				{ label: "lite", model: "google-vertex/gemini-3.7-flash" },
			],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /low/);
	});

	it("requires at least 2 tiny models", () => {
		const result = validateConfig({
			models: [{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" }],
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /at least 2/);
	});

	it("rejects duplicate labels and models", () => {
		const base = { thinking: "low" };
		assert.match(
			(
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
			(
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
			(
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
			(
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
			(
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
			(
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

	it("resolves configured models only when all are available", () => {
		const valid = validateConfig({
			models: [
				{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
				{ label: "lite", model: "google-vertex/gemini-3.7-flash", thinking: "low" },
			],
		});
		assert.equal(valid.ok, true);
		if (!valid.ok) return;

		const ok = resolveModels(
			{ status: "loaded", config: { ...valid.config, source: "config", warnings: [] }, path: "/fake" },
			{
				available: () => true,
			},
		);
		assert.equal(ok.ok, true);
		if (ok.ok) assert.equal(ok.config.source, "config");

		const bad = resolveModels(
			{ status: "loaded", config: { ...valid.config, source: "config", warnings: [] }, path: "/fake" },
			{
				available: (provider) => provider === "openai",
			},
		);
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.match(bad.error, /gemini-3.7-flash/);
	});

	it("falls back to defaults filtered to available", () => {
		const dir = mkdtempSync(join(tmpdir(), "pr-autopilot-config-"));
		try {
			const result = resolveModels(
				{ status: "missing", path: dir },
				{
					available: (provider, modelId) =>
						provider === "openai" || (provider === "google-vertex" && modelId.includes("gemini")),
				},
			);
			assert.equal(result.ok, true);
			if (result.ok) {
				assert.equal(result.config.source, "default");
				// Only 2 of the 3 defaults match the filter; that's exactly the minimum.
				assert.equal(result.config.models.length, 2);
				assert.ok(result.config.warnings.length > 0);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
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
							{ label: "lite", model: "google-vertex/gemini-3.7-flash", thinking: "low" },
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

	it("still loads a legacy pr-babysit section and warns to rename it", () => {
		const dir = mkdtempSync(join(tmpdir(), "pr-autopilot-legacy-"));
		try {
			writeFileSync(
				join(dir, "kstack.json"),
				JSON.stringify({
					"pr-babysit": {
						models: [
							{ label: "luna", model: "openai/gpt-5.6-luna", thinking: "low" },
							{ label: "lite", model: "google-vertex/gemini-3.7-flash", thinking: "low" },
						],
					},
				}),
			);
			const result = loadConfig({ PI_CODING_AGENT_DIR: dir });
			assert.equal(result.status, "loaded");
			if (result.status === "loaded") {
				assert.match(result.config.warnings.join("\n"), /pr-babysit/);
				assert.equal(result.config.models.length, 2);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
