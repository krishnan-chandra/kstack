import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
	BUILT_IN_ROUTING,
	loadRoutingConfig,
	type RoutingConfig,
	resolveVariant,
	validateRoutingConfig,
} from "./routing-policy.ts";

it("validates exact OpenRouter config and defaults", () => {
	assert.deepEqual(validateRoutingConfig({}), { ok: true, config: { default: "floor", models: new Map() } });
	assert.deepEqual(validateRoutingConfig({ default: "none", models: { "openrouter/openai/gpt-5.6-sol": "nitro" } }), {
		ok: true,
		config: { default: "none", models: new Map([["openai/gpt-5.6-sol", "nitro"]]) },
	});
	for (const value of [
		null,
		[],
		"floor",
		{ defualt: "floor" },
		{ default: null },
		{ models: [] },
		{ models: { "openai/gpt": "floor" } },
		{ models: { "openrouter/openai/gpt:free": "floor" } },
		{ models: { "openrouter/": "floor" } },
		{ models: { "openrouter/auto:free": "floor" } },
		{ models: { "openrouter/author//model": "floor" } },
		{ models: { "openrouter/openai/bad model": "floor" } },
		{ models: { "openrouter/openai/gpt": "fast" } },
	]) {
		const result = validateRoutingConfig(value);
		assert.equal(result.ok, false, JSON.stringify(value));
		if (!result.ok) assert.match(result.error, /openrouter-floor/);
	}
});
it("accepts and resolves slashless catalog and custom OpenRouter IDs", () => {
	const result = validateRoutingConfig({
		models: { "openrouter/auto": "none", "openrouter/custom-id": "nitro", "openrouter/openai/gpt": "nitro" },
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.config.models.size, 3);
	assert.deepEqual(
		resolveVariant({
			config: result.config,
			sessionOverride: undefined,
			model: { provider: "openrouter", id: "auto" },
		}),
		{ variant: "none", source: "config-model" },
	);
});
it("resolves every precedence rung, including unknown explicit suffixes", () => {
	const model = { provider: "openrouter", id: "openai/gpt" };
	const config: RoutingConfig = { default: "none", models: new Map([[model.id, "nitro"]]) };
	const resolve = (overrides: Partial<Parameters<typeof resolveVariant>[0]> = {}) =>
		resolveVariant({ model, config, sessionOverride: undefined, ...overrides });
	assert.deepEqual(resolve(), { variant: "nitro", source: "config-model" });
	assert.deepEqual(resolve({ sessionOverride: "floor" }), { variant: "floor", source: "session-override" });
	assert.deepEqual(resolve({ model: { ...model, id: "other/model" } }), { variant: "none", source: "config-default" });
	assert.deepEqual(resolve({ config: BUILT_IN_ROUTING }), { variant: "floor", source: "built-in" });
	assert.deepEqual(resolve({ model: { ...model, id: "openai/gpt:free" }, sessionOverride: "nitro" }), {
		variant: "free",
		source: "model-suffix",
	});
	assert.equal(resolve({ model: undefined }), undefined);
	assert.equal(resolve({ model: { ...model, provider: "openai" } }), undefined);
});
it("loads missing, valid, and invalid configuration from an isolated agent directory", () => {
	const root = mkdtempSync(join(tmpdir(), "routing-policy-"));
	const env = { PI_CODING_AGENT_DIR: root };
	try {
		assert.equal(loadRoutingConfig(env).status, "missing");
		writeFileSync(join(root, "kstack.json"), JSON.stringify({ "openrouter-floor": { default: "nitro" } }));
		const loaded = loadRoutingConfig(env);
		assert.equal(loaded.status, "loaded");
		if (loaded.status === "loaded") assert.equal(loaded.config.default, "nitro");
		writeFileSync(join(root, "kstack.json"), JSON.stringify({ "openrouter-floor": { default: "wrong" } }));
		assert.equal(loadRoutingConfig(env).status, "invalid");
		writeFileSync(join(root, "kstack.json"), "{");
		assert.equal(loadRoutingConfig(env).status, "invalid");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
