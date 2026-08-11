import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PANEL, modelCliId, resolveReviewers, validateConfig } from "./config.ts";

describe("validateConfig", () => {
	it("accepts a valid config", () => {
		const r = validateConfig({
			reviewers: [
				{ label: "A", model: "anthropic/claude-sonnet-4-5", thinking: "high" },
				{ label: "B", model: "openai/gpt-5.4" },
			],
			maxConcurrency: 2,
		});
		assert.ok(r.ok);
		assert.equal(r.config.maxConcurrency, 2);
	});
	it("rejects 1 or 5+ reviewers", () => {
		assert.ok(!validateConfig({ reviewers: [{ label: "A", model: "a/b" }] }).ok);
		assert.ok(
			!validateConfig({
				reviewers: ["A", "B", "C", "D", "E"].map((label) => ({ label, model: "a/b" })),
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
	it("accepts multi-segment model ids like openrouter/moonshotai/kimi-k3", () => {
		const r = validateConfig({
			reviewers: [
				{ label: "kimi", model: "openrouter/moonshotai/kimi-k3", thinking: "high" },
				{ label: "sol", model: "openai/gpt-5.6-sol" },
			],
		});
		assert.ok(r.ok);
		assert.equal(r.config.reviewers[0].model, "openrouter/moonshotai/kimi-k3");
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
		});
		assert.ok(good.ok);
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
		};
		const ok = resolveReviewers(config, { find: find(["anthropic/x", "openai/y"]), scopedModels: [] });
		assert.ok(ok.ok);
		assert.equal(ok.reviewers.length, 2);

		const bad = resolveReviewers(config, { find: find(["anthropic/x"]), scopedModels: [] });
		assert.ok(!bad.ok);
		assert.match(bad.error, /openai\/y/);
	});

	it("uses the default low-cost panel when no config exists", () => {
		const available = DEFAULT_PANEL.map((r) => r.model);
		const r = resolveReviewers(null, { find: find(available), scopedModels: [] });
		assert.ok(r.ok);
		assert.deepEqual(
			r.reviewers.map((x) => x.model),
			available,
		);
		assert.equal(r.reviewers.length, 3);
		assert.equal(r.warnings.length, 0);
		// Thinking levels ride along for the CLI model id.
		assert.ok(r.reviewers.every((x) => x.thinking));
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
		assert.equal(r.reviewers.length, 4);
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
