import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_IMPLEMENTERS, DEFAULT_PLANNERS, loadConfig, modelCliId, resolveRoles, validateConfig } from "./config.ts";

describe("plan-implement config", () => {
	it("validates distinct role models and defaults planner thinking", () => {
		const result = validateConfig({
			planner: { model: "openai/planner" },
			implementer: { model: "openrouter/worker" },
			timeoutMinutes: 12,
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.config.planner.thinking, "high");
			assert.equal(result.config.timeoutMinutes, 12);
		}
	});

	it("rejects low planner thinking, same models, and invalid timeouts", () => {
		const base = { planner: { model: "a/planner", thinking: "high" }, implementer: { model: "b/worker" } };
		assert.match((validateConfig({ ...base, planner: { ...base.planner, thinking: "low" } }) as { error: string }).error, /high, xhigh, or max/);
		assert.match((validateConfig({ ...base, implementer: { model: "a/planner" } }) as { error: string }).error, /different models/);
		assert.match((validateConfig({ ...base, timeoutMinutes: 0 }) as { error: string }).error, /1 to 60/);
	});

	it("resolves configured models only when both are available", () => {
		const config = validateConfig({ planner: { model: "a/p", thinking: "max" }, implementer: { model: "b/i" } });
		assert.equal(config.ok, true);
		if (!config.ok) return;
		const ok = resolveRoles(config.config, { available: () => true });
		assert.equal(ok.ok, true);
		if (ok.ok) assert.equal(ok.roles.source, "config");
		const bad = resolveRoles(config.config, { available: (provider) => provider === "a" });
		assert.equal(bad.ok, false);
		if (!bad.ok) assert.match(bad.error, /b\/i/);
	});

	it("prefers Sol high and Grok high by default", () => {
		const available = new Set([DEFAULT_PLANNERS[0].model, DEFAULT_IMPLEMENTERS[0].model]);
		const result = resolveRoles(null, { available: (provider, id) => available.has(`${provider}/${id}`) });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.roles.planner, { model: "openai/gpt-5.6-sol", thinking: "high" });
			assert.deepEqual(result.roles.implementer, { model: "openrouter/x-ai/grok-4.6", thinking: "high" });
		}
	});

	it("uses later ordered defaults when preferred models are unavailable", () => {
		const available = new Set([DEFAULT_PLANNERS[1].model, DEFAULT_IMPLEMENTERS[2].model]);
		const result = resolveRoles(null, { available: (provider, id) => available.has(`${provider}/${id}`) });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.roles.planner, DEFAULT_PLANNERS[1]);
			assert.deepEqual(result.roles.implementer, DEFAULT_IMPLEMENTERS[2]);
			assert.equal(result.roles.source, "default");
		}
	});

	it("fails rather than falling back to an arbitrary active model", () => {
		const result = resolveRoles(null, { available: () => false });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /No high-reason planner/);
	});

	it("loads only the plan-implement section from unified kstack.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "plan-implement-config-"));
		try {
			writeFileSync(
				join(dir, "kstack.json"),
				JSON.stringify({ other: { ignored: true }, "plan-implement": { planner: { model: "a/p", thinking: "high" }, implementer: { model: "b/i" } } }),
			);
			const result = loadConfig({ PI_CODING_AGENT_DIR: dir });
			assert.equal(result.status, "loaded");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("formats CLI model ids", () => {
		assert.equal(modelCliId({ model: "a/b", thinking: "xhigh" }), "a/b:xhigh");
		assert.equal(modelCliId({ model: "a/b" }), "a/b");
	});
});
