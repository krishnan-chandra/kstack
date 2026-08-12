import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveInvestigationModel, validateInvestigationConfig } from "./investigation-model.mjs";

describe("investigation model allowlist", () => {
	it("uses a built-in fast default when no section is configured", () => {
		const result = resolveInvestigationModel(undefined, { PI_CODING_AGENT_DIR: "/definitely/missing-kstack-config" });
		assert.ok(result.ok);
		assert.equal(result.model, "openai/gpt-5.6-luna");
		assert.equal(result.thinking, "low");
	});

	it("accepts only an allowlisted configured model", () => {
		const result = validateInvestigationConfig({
			allowedModels: [{ model: "fast/model", thinking: "low" }],
			defaultModel: "fast/model",
		});
		assert.ok(result.ok);
		if (result.ok) assert.equal(result.config.defaultModel, "fast/model");

		const dir = mkdtempSync(join(tmpdir(), "kstack-investigation-"));
		try {
			writeFileSync(join(dir, "kstack.json"), JSON.stringify({ investigation: result.ok ? result.config : {} }));
			assert.ok(resolveInvestigationModel("fast/model", { PI_CODING_AGENT_DIR: dir }).ok);
			assert.ok(!resolveInvestigationModel("other/model", { PI_CODING_AGENT_DIR: dir }).ok);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a default that is outside the allowlist", () => {
		const result = validateInvestigationConfig({
			allowedModels: [{ model: "fast/model" }],
			defaultModel: "slow/model",
		});
		assert.ok(!result.ok);
	});

	it("rejects duplicate, malformed, and heavyweight allowlist entries", () => {
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "fast/model" }, { model: "fast/model" }] }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "not-a-model" }] }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "openai/gpt-5.6-sol" }] }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "anthropic/claude-fable-5" }] }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "anthropic/claude-opus-5" }] }).ok);
	});
});
