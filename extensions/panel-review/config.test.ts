import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_PANEL, DEFAULT_SYNTHESIS, getKstackPath, loadConfig, modelCliId, resolveReviewers, resolveSynthesisModel, validateConfig } from "./config.ts";

describe("validateConfig", () => {
	it("accepts a valid config", () => {
		const r = validateConfig({
			reviewers: [
				{ label: "A", model: "anthropic/claude-sonnet-4-5", thinking: "high" },
				{ label: "B", model: "openai/gpt-5.4" },
			],
			maxConcurrency: 2,
			synthesis: { model: "openrouter/google/gemini-3.5-flash-lite" },
		});
		assert.ok(r.ok);
		assert.equal(r.config.maxConcurrency, 2);
		assert.equal(r.config.synthesis.model, "openrouter/google/gemini-3.5-flash-lite");
	});
	it("applies default timeouts and accepts overrides", () => {
		const base = {
			reviewers: [
				{ label: "A", model: "anthropic/claude-sonnet-4-5", thinking: "high" },
				{ label: "B", model: "openai/gpt-5.4" },
			],
			synthesis: { model: "openrouter/google/gemini-3.5-flash-lite" },
		};
		const def = validateConfig(base);
		assert.ok(def.ok);
		assert.equal(def.config.timeoutMinutes, 10);
		assert.equal(def.config.maxRuntimeMinutes, 30);
		const custom = validateConfig({ ...base, timeoutMinutes: 5, maxRuntimeMinutes: 45 });
		assert.ok(custom.ok);
		assert.equal(custom.config.timeoutMinutes, 5);
		assert.equal(custom.config.maxRuntimeMinutes, 45);
	});

	it("rejects invalid timeout values", () => {
		const base = {
			reviewers: [
				{ label: "A", model: "a/b" },
				{ label: "B", model: "c/d" },
			],
			synthesis: { model: "a/b" },
		};
		for (const timeoutMinutes of [0, -1, "10", Number.NaN]) {
			const r = validateConfig({ ...base, timeoutMinutes });
			assert.ok(!r.ok);
			if (!r.ok) assert.match(r.error, /timeoutMinutes/);
		}
		for (const maxRuntimeMinutes of [0, -5, "30"]) {
			const r = validateConfig({ ...base, maxRuntimeMinutes });
			assert.ok(!r.ok);
			if (!r.ok) assert.match(r.error, /maxRuntimeMinutes/);
		}
		const inverted = validateConfig({ ...base, timeoutMinutes: 20, maxRuntimeMinutes: 10 });
		assert.ok(!inverted.ok);
		if (!inverted.ok) assert.match(inverted.error, />= "timeoutMinutes"/);
	});

	it("accepts 5 reviewers and rejects 1 or 6+", () => {
		assert.ok(!validateConfig({ reviewers: [{ label: "A", model: "a/b" }] }).ok);
		assert.ok(
			validateConfig({
				reviewers: ["A", "B", "C", "D", "E"].map((label) => ({ label, model: "a/b" })),
				synthesis: { model: "a/b" },
			}).ok,
		);
		assert.ok(
			!validateConfig({
				reviewers: ["A", "B", "C", "D", "E", "F"].map((label) => ({ label, model: "a/b" })),
			}).ok,
		);
	});
	it("rejects duplicate labels and malformed models", () => {
		assert.ok(
			!validateConfig({
				reviewers: [
					{ label: "A", model: "a/b" },
					{ label: "A", model: "c/d" },
				],
			}).ok,
		);
		assert.ok(
			!validateConfig({
				reviewers: [
					{ label: "A", model: "noslash" },
					{ label: "B", model: "a/b" },
				],
			}).ok,
		);
	});
	it("accepts multi-segment model ids like openrouter/deepseek/deepseek-v4-pro", () => {
		const r = validateConfig({
			reviewers: [
				{ label: "deepseek", model: "openrouter/deepseek/deepseek-v4-pro", thinking: "medium" },
				{ label: "sol", model: "openai/gpt-5.6-sol" },
			],
			synthesis: { model: "openrouter/google/gemini-3.5-flash-lite" },
		});
		assert.ok(r.ok);
		assert.equal(r.config.reviewers[0].model, "openrouter/deepseek/deepseek-v4-pro");
		assert.equal(r.config.synthesis.model, "openrouter/google/gemini-3.5-flash-lite");
	});

	it("rejects unknown thinking levels", () => {
		const bad = validateConfig({
			reviewers: [
				{ label: "A", model: "a/b", thinking: "banana" },
				{ label: "B", model: "c/d" },
			],
		});
		assert.ok(!bad.ok);
		assert.match(bad.error, /banana/);
		const good = validateConfig({
			reviewers: [
				{ label: "A", model: "a/b", thinking: "xhigh" },
				{ label: "B", model: "c/d", thinking: "low" },
			],
			synthesis: { model: "a/b" },
		});
		assert.ok(good.ok);
	});

	it("requires a synthesis entry with a valid model", () => {
		const missing = validateConfig({
			reviewers: [
				{ label: "A", model: "a/b" },
				{ label: "B", model: "c/d" },
			],
		});
		assert.ok(!missing.ok);
		assert.match(missing.error, /"synthesis" is required/);

		const badModel = validateConfig({
			reviewers: [
				{ label: "A", model: "a/b" },
				{ label: "B", model: "c/d" },
			],
			synthesis: { model: "noslash" },
		});
		assert.ok(!badModel.ok);
		assert.match(badModel.error, /synthesis\.model/);

		const badThinking = validateConfig({
			reviewers: [
				{ label: "A", model: "a/b" },
				{ label: "B", model: "c/d" },
			],
			synthesis: { model: "a/b", thinking: "banana" },
		});
		assert.ok(!badThinking.ok);
		assert.match(badThinking.error, /synthesis\.thinking/);

		const good = validateConfig({
			reviewers: [
				{ label: "A", model: "a/b" },
				{ label: "B", model: "c/d" },
			],
			synthesis: { model: "openrouter/google/gemini-3.5-flash-lite", thinking: "low" },
		});
		assert.ok(good.ok);
		assert.equal(good.config.synthesis.thinking, "low");
	});
});

describe("modelCliId", () => {
	it("appends thinking level", () => {
		assert.equal(modelCliId({ label: "A", model: "a/b", thinking: "high" }), "a/b:high");
		assert.equal(modelCliId({ label: "A", model: "a/b" }), "a/b");
	});
});

const find =
	(available: string[]) =>
	(provider: string, modelId: string) =>
		available.includes(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined;

describe("resolveReviewers", () => {
	it("uses config reviewers and reports unavailable models", () => {
		const config = {
			reviewers: [
				{ label: "A", model: "anthropic/x" },
				{ label: "B", model: "openai/y" },
			],
			maxConcurrency: 4,
			synthesis: { model: "openrouter/google/gemini-3.5-flash-lite" },
		};
		const ok = resolveReviewers(config, { find: find(["anthropic/x", "openai/y"]), scopedModels: [] });
		assert.ok(ok.ok);
		assert.equal(ok.reviewers.length, 2);

		const bad = resolveReviewers(config, { find: find(["anthropic/x"]), scopedModels: [] });
		assert.ok(!bad.ok);
		assert.match(bad.error, /openai\/y/);
	});

	it("uses the five default reviewers without Terra when no config exists", () => {
		const available = DEFAULT_PANEL.map((r) => r.model);
		const r = resolveReviewers(null, { find: find(available), scopedModels: [] });
		assert.ok(r.ok);
		assert.deepEqual(r.reviewers, [
			{ label: "glm", model: "openrouter/z-ai/glm-5.2", thinking: "high" },
			{ label: "deepseek", model: "openrouter/deepseek/deepseek-v4-pro", thinking: "medium" },
			{ label: "grok", model: "openrouter/x-ai/grok-4.6", thinking: "medium" },
			{ label: "gemini", model: "openrouter/google/gemini-3.6-flash", thinking: "high" },
			{ label: "muse", model: "openrouter/meta/muse-spark-1.2", thinking: "high" },
		]);
		assert.equal(r.maxConcurrency, 5);
		assert.equal(r.warnings.length, 0);
	});

	it("skips unavailable default panel models with a warning", () => {
		const r = resolveReviewers(null, {
			find: find([DEFAULT_PANEL[0].model, DEFAULT_PANEL[2].model]),
			scopedModels: [],
		});
		assert.ok(r.ok);
		assert.deepEqual(
			r.reviewers.map((x) => x.model),
			[DEFAULT_PANEL[0].model, DEFAULT_PANEL[2].model],
		);
		assert.match(r.warnings[0], new RegExp(DEFAULT_PANEL[1].model.replace(/\//g, "\\/")));
	});

	it("falls through to scoped models when fewer than two defaults are available", () => {
		const r = resolveReviewers(null, {
			find: find([DEFAULT_PANEL[0].model]),
			scopedModels: [
				{ model: { provider: "anthropic", id: "m1" } },
				{ model: { provider: "openai", id: "m2" } },
			],
		});
		assert.ok(r.ok);
		assert.deepEqual(
			r.reviewers.map((x) => x.model),
			["anthropic/m1", "openai/m2"],
		);
	});

	it("falls back to scoped models preferring provider diversity", () => {
		const scopedModels = [
			{ model: { provider: "anthropic", id: "m1" } },
			{ model: { provider: "anthropic", id: "m2" } },
			{ model: { provider: "openai", id: "m3" } },
			{ model: { provider: "google", id: "m4" } },
			{ model: { provider: "google", id: "m5" } },
		];
		const r = resolveReviewers(null, { find: find([]), scopedModels });
		assert.ok(r.ok);
		assert.equal(r.reviewers.length, 5);
		const providers = r.reviewers.map((x) => x.model.split("/")[0]);
		// Round-robin: first three must be distinct providers.
		assert.equal(new Set(providers.slice(0, 3)).size, 3);
	});

	it("runs two reviewers on the active model when diversity is impossible", () => {
		const r = resolveReviewers(null, {
			find: find([]),
			scopedModels: [],
			activeModel: { provider: "anthropic", id: "only" },
		});
		assert.ok(r.ok);
		assert.equal(r.reviewers.length, 2);
		assert.equal(r.reviewers[0].model, "anthropic/only");
		assert.ok(r.warnings.some((w) => /diversity is reduced/.test(w)));
	});

	it("errors when no model is available at all", () => {
		const r = resolveReviewers(null, { find: find([]), scopedModels: [] });
		assert.ok(!r.ok);
	});
});

describe("resolveSynthesisModel", () => {
	it("uses the configured synthesis model when available", () => {
		const config = {
			reviewers: [
				{ label: "A", model: "anthropic/x" },
				{ label: "B", model: "openai/y" },
			],
			maxConcurrency: 4,
			synthesis: { model: "openrouter/google/gemini-3.5-flash-lite", thinking: "low" },
		};
		const r = resolveSynthesisModel(config, { find: find(["openrouter/google/gemini-3.5-flash-lite"]), scopedModels: [] });
		assert.ok(r.ok);
		assert.equal(r.model, "openrouter/google/gemini-3.5-flash-lite");
		assert.equal(r.thinking, "low");
		assert.equal(r.source, "config");
	});

	it("hard-errors when the configured synthesis model is unavailable", () => {
		const config = {
			reviewers: [
				{ label: "A", model: "anthropic/x" },
				{ label: "B", model: "openai/y" },
			],
			maxConcurrency: 4,
			synthesis: { model: "openrouter/google/gemini-3.5-flash-lite" },
		};
		const r = resolveSynthesisModel(config, { find: find(["anthropic/x"]), scopedModels: [] });
		assert.ok(!r.ok);
		assert.match(r.error, /gemini-3\.5-flash-lite/);
	});

	it("uses the built-in small, fast default without a config", () => {
		const r = resolveSynthesisModel(null, { find: find([DEFAULT_SYNTHESIS.model]), scopedModels: [] });
		assert.ok(r.ok);
		assert.equal(r.model, DEFAULT_SYNTHESIS.model);
		assert.equal(r.thinking, "medium");
		assert.equal(r.source, "default");
		assert.equal(r.warnings.length, 0);
	});

	it("falls back to the active model with a warning when the default is unavailable", () => {
		const r = resolveSynthesisModel(null, {
			find: find([]),
			scopedModels: [],
			activeModel: { provider: "anthropic", id: "current" },
		});
		assert.ok(r.ok);
		assert.equal(r.model, "anthropic/current");
		assert.equal(r.source, "active");
		assert.ok(r.warnings.some((w) => w.includes(DEFAULT_SYNTHESIS.model)));
	});

	it("errors when neither the default nor an active model exists", () => {
		const r = resolveSynthesisModel(null, { find: find([]), scopedModels: [] });
		assert.ok(!r.ok);
	});
});

describe("loadConfig — kstack.json", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "pi-config-test-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const env = () => ({ PI_CODING_AGENT_DIR: tmpDir });

	const validPanelReview = {
		reviewers: [
			{ label: "A", model: "anthropic/claude-sonnet-4-5" },
			{ label: "B", model: "openai/gpt-5.4" },
		],
		synthesis: { model: "openrouter/google/gemini-3.5-flash-lite" },
	};

	it("returns missing when kstack.json does not exist", () => {
		const r = loadConfig(env());
		assert.equal(r.status, "missing");
		assert.equal(r.path, getKstackPath(env()));
	});

	it("loads from kstack.json panel-review section", () => {
		writeFileSync(join(tmpDir, "kstack.json"), JSON.stringify({ "panel-review": validPanelReview }));
		const r = loadConfig(env());
		assert.equal(r.status, "loaded");
		assert.equal(r.path, getKstackPath(env()));
		if (r.status === "loaded") {
			assert.equal(r.config.reviewers.length, 2);
			assert.equal(r.config.synthesis.model, "openrouter/google/gemini-3.5-flash-lite");
		}
	});

	it("ignores legacy panel-review.json even when present", () => {
		writeFileSync(join(tmpDir, "panel-review.json"), JSON.stringify(validPanelReview));
		const r = loadConfig(env());
		assert.equal(r.status, "missing");
		assert.equal(r.path, getKstackPath(env()));
	});

	it("returns missing when kstack.json exists but has no panel-review section", () => {
		writeFileSync(join(tmpDir, "kstack.json"), JSON.stringify({ arena: {} }));
		const r = loadConfig(env());
		assert.equal(r.status, "missing");
	});

	it("returns invalid when kstack.json panel-review section is malformed", () => {
		writeFileSync(join(tmpDir, "kstack.json"), JSON.stringify({ "panel-review": { reviewers: "bad" } }));
		const r = loadConfig(env());
		assert.equal(r.status, "invalid");
		assert.equal(r.path, getKstackPath(env()));
	});

	it("returns invalid when kstack.json is not valid JSON", () => {
		writeFileSync(join(tmpDir, "kstack.json"), "not json");
		const r = loadConfig(env());
		assert.equal(r.status, "invalid");
	});
});
