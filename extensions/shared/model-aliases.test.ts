import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	collectCatalogueNameAliases,
	collectKstackModelAliases,
	matchModelAliases,
	normalizeModelAliasKey,
} from "./model-aliases.ts";

describe("normalizeModelAliasKey", () => {
	it("lowercases and collapses whitespace", () => {
		assert.equal(normalizeModelAliasKey("  Claude   Sonnet 4.5 "), "claude sonnet 4.5");
	});
});

describe("collectKstackModelAliases", () => {
	it("collects labelled model entries at any nesting depth", () => {
		const root = {
			"panel-review": {
				reviewers: [
					{ label: "terra", model: "openai/gpt-5.6-terra", thinking: "max" },
					{ label: "gemini", model: "google-vertex/gemini-3.7-flash", thinking: "high" },
				],
			},
			arena: { runners: [{ label: "kimi", model: "openrouter/moonshotai/kimi-k3" }] },
		};
		const aliases = collectKstackModelAliases(root);
		assert.deepEqual(
			aliases.map((a) => [a.alias, a.modelRef, a.thinking, a.source]),
			[
				["terra", "openai/gpt-5.6-terra", "max", "kstack.json"],
				["gemini", "google-vertex/gemini-3.7-flash", "high", "kstack.json"],
				["kimi", "openrouter/moonshotai/kimi-k3", undefined, "kstack.json"],
			],
		);
	});

	it("skips entries with invalid labels, models, or thinking levels", () => {
		const root = {
			section: {
				models: [
					{ label: "has space", model: "openai/gpt-5.2" },
					{ label: "badmodel", model: "no-slash" },
					{ label: "ok", model: "acme/no-provider?", thinking: "loud" },
					{ label: "good", model: "openai/gpt-5.2", thinking: "loud" },
					{ label: 42, model: "openai/gpt-5.2" },
				],
			},
		};
		const aliases = collectKstackModelAliases(root);
		// "ok" matches MODEL_ID_RE via the slash; invalid thinking is dropped, not fatal.
		assert.deepEqual(
			aliases.map((a) => [a.alias, a.thinking]),
			[
				["ok", undefined],
				["good", undefined],
			],
		);
	});

	it("dedupes identical label/model pairs across sections", () => {
		const root = {
			a: { models: [{ label: "Terra", model: "openai/gpt-5.6-terra" }] },
			b: { models: [{ label: "terra", model: "openai/gpt-5.6-terra" }] },
		};
		const aliases = collectKstackModelAliases(root);
		assert.equal(aliases.filter((a) => a.key === "terra").length, 1);
	});

	it("ignores non-object content", () => {
		assert.deepEqual(collectKstackModelAliases({}), []);
		assert.deepEqual(collectKstackModelAliases({ a: [1, "x", null], b: "str" }), []);
	});
});

describe("collectCatalogueNameAliases", () => {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
		{ provider: "openai", id: "gpt-5.2", name: "gpt-5.2" },
		{ provider: "openai", id: "gpt-5.2-codex" },
	];

	it("creates normalized and slug keys for display names", () => {
		const aliases = collectCatalogueNameAliases(models);
		const keys = aliases.filter((a) => a.alias === "Claude Sonnet 4.5").map((a) => a.key);
		assert.deepEqual(keys.sort(), ["claude sonnet 4.5", "claude-sonnet-4.5"]);
		assert.equal(aliases[0].modelRef, "anthropic/claude-sonnet-4-5");
		assert.equal(aliases[0].source, "model name");
	});

	it("skips names equal to the model id and missing names", () => {
		const aliases = collectCatalogueNameAliases(models);
		assert.ok(!aliases.some((a) => a.modelRef.startsWith("openai/")));
	});
});

describe("matchModelAliases", () => {
	const aliases = [
		...collectKstackModelAliases({ s: { models: [{ label: "terra", model: "openai/gpt-5.6-terra" }] } }),
		...collectCatalogueNameAliases([{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]),
	];

	it("matches labels case-insensitively", () => {
		assert.equal(matchModelAliases(aliases, "TERRA").length, 1);
	});

	it("matches display names by normalized and slug forms", () => {
		assert.equal(matchModelAliases(aliases, "claude sonnet 4.5").length, 1);
		assert.equal(matchModelAliases(aliases, "Claude-Sonnet-4.5").length, 1);
	});

	it("does not match partial names", () => {
		assert.equal(matchModelAliases(aliases, "sonnet").length, 0);
		assert.equal(matchModelAliases(aliases, "").length, 0);
		assert.equal(matchModelAliases([], "terra").length, 0);
	});
});
