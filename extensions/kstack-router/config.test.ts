import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resolveClassifierModel, validateRouterConfig } from "./config.ts";

describe("kstack-router config validation", () => {
	it("accepts empty config", () => {
		const r = validateRouterConfig({});
		assert.ok(r.ok);
		assert.deepEqual(r.config, {});
	});

	it("rejects non-object", () => {
		assert.ok(!validateRouterConfig("string").ok);
		assert.ok(!validateRouterConfig(null).ok);
		assert.ok(!validateRouterConfig([]).ok);
	});

	it("validates classifier model", () => {
		const r = validateRouterConfig({ classifier: { model: "provider/model" } });
		assert.ok(r.ok);
		assert.equal(r.config.classifier?.model, "provider/model");
	});

	it("rejects invalid classifier model", () => {
		assert.ok(!validateRouterConfig({ classifier: { model: "no-slash" } }).ok);
		assert.ok(!validateRouterConfig({ classifier: { model: 42 } }).ok);
	});

	it("validates classifier thinking", () => {
		const r = validateRouterConfig({ classifier: { model: "p/m", thinking: "low" } });
		assert.ok(r.ok);
		assert.equal(r.config.classifier?.thinking, "low");
	});

	it("rejects invalid thinking level", () => {
		assert.ok(!validateRouterConfig({ classifier: { model: "p/m", thinking: "turbo" } }).ok);
	});

	it("validates timeoutSeconds", () => {
		const r = validateRouterConfig({ timeoutSeconds: 60 });
		assert.ok(r.ok);
		assert.equal(r.config.timeoutSeconds, 60);
	});

	it("rejects invalid timeoutSeconds", () => {
		assert.ok(!validateRouterConfig({ timeoutSeconds: 0 }).ok);
		assert.ok(!validateRouterConfig({ timeoutSeconds: 601 }).ok);
		assert.ok(!validateRouterConfig({ timeoutSeconds: -1 }).ok);
		assert.ok(!validateRouterConfig({ timeoutSeconds: "slow" }).ok);
	});
});

describe("kstack-router config loading", () => {
	const tempDir = join(tmpdir(), `kstack-router-test-${Date.now()}`);
	const configPath = join(tempDir, "kstack.json");

	beforeEach(() => {
		mkdirSync(tempDir, { recursive: true });
		const _env = { PI_CODING_AGENT_DIR: tempDir };
		// Override getKstackPath to use our temp dir.
		// Use the original function via the module.
	});

	afterEach(() => {
		try {
			if (existsSync(configPath)) unlinkSync(configPath);
			try {
				unlinkSync(configPath);
			} catch {}
		} catch {}
	});

	it("returns missing when no config file", () => {
		const result = loadConfig({ PI_CODING_AGENT_DIR: tempDir });
		assert.equal(result.status, "missing");
	});

	it("returns missing when config has no kstack-router section", () => {
		writeFileSync(configPath, JSON.stringify({}), "utf8");
		const result = loadConfig({ PI_CODING_AGENT_DIR: tempDir });
		assert.equal(result.status, "missing");
	});

	it("loads valid config", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				"kstack-router": { classifier: { model: "p/m", thinking: "low" }, timeoutSeconds: 90 },
			}),
			"utf8",
		);
		const result = loadConfig({ PI_CODING_AGENT_DIR: tempDir });
		assert.equal(result.status, "loaded");
		if (result.status === "loaded") {
			assert.equal(result.config.classifier?.model, "p/m");
			assert.equal(result.config.classifier?.thinking, "low");
			assert.equal(result.config.timeoutSeconds, 90);
		}
	});

	it("returns invalid for bad config", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				"kstack-router": { classifier: { model: 42 } },
			}),
			"utf8",
		);
		const result = loadConfig({ PI_CODING_AGENT_DIR: tempDir });
		assert.equal(result.status, "invalid");
	});
});

describe("resolveClassifierModel", () => {
	const deps = {
		available: (provider: string) => provider === "available",
		activeModelId: "active/mymodel",
	};

	it("uses configured model when available", () => {
		const result = resolveClassifierModel(
			{ classifier: { model: "available/model", thinking: "low" } },
			{ available: (p: string) => p === "available", activeModelId: "active/mymodel" },
		);
		if ("error" in result) assert.fail("should not error");
		assert.equal(result.modelId, "available/model");
		assert.equal(result.source, "config");
		assert.equal(result.thinking, "low");
	});

	it("uses low thinking for the default and omits it for the active fallback", () => {
		const fallback = resolveClassifierModel(null, {
			available: () => true,
			activeModelId: "active/mymodel",
		});
		if ("error" in fallback) assert.fail("should not error");
		assert.equal(fallback.source, "default");
		assert.equal(fallback.thinking, "low");

		const active = resolveClassifierModel(null, {
			available: () => false,
			activeModelId: "active/mymodel",
		});
		if ("error" in active) assert.fail("should not error");
		assert.equal(active.source, "active");
		assert.equal(active.thinking, undefined);
	});

	it("returns error when configured model is unavailable", () => {
		const result = resolveClassifierModel({ classifier: { model: "unavailable/model" } }, deps);
		assert.ok("error" in result);
	});

	it("falls back to active model when default unavailable", () => {
		const result = resolveClassifierModel(null, {
			available: () => false,
			activeModelId: "active/mymodel",
		});
		if ("error" in result) assert.fail("should not error");
		assert.equal(result.modelId, "active/mymodel");
		assert.equal(result.source, "active");
	});

	it("returns error when no model available", () => {
		const result = resolveClassifierModel(null, {
			available: () => false,
			activeModelId: undefined,
		});
		assert.ok("error" in result);
	});
});
