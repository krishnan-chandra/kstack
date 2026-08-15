import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveInvestigationModel, validateInvestigationConfig } from "./investigation-model.mjs";

const luna = { model: "openai/gpt-5.6-luna", thinking: "medium" };
const terra = { model: "openai/gpt-5.6-terra", thinking: "medium" };
const script = fileURLToPath(new URL("./investigation-model.mjs", import.meta.url));

describe("investigation model allowlist", () => {
	it("uses a built-in fast default when no section is configured", () => {
		const result = resolveInvestigationModel(undefined, { PI_CODING_AGENT_DIR: "/definitely/missing-kstack-config" });
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.model, luna.model);
			assert.equal(result.thinking, luna.thinking);
			assert.equal(result.spec, "openai/gpt-5.6-luna:medium");
		}
	});

	it("accepts only a configured fast investigation model", () => {
		const result = validateInvestigationConfig({ allowedModels: [luna], defaultModel: luna.model });
		assert.ok(result.ok);
		if (result.ok) assert.equal(result.config.defaultModel, luna.model);

		const dir = mkdtempSync(join(tmpdir(), "kstack-investigation-"));
		try {
			writeFileSync(join(dir, "kstack.json"), JSON.stringify({ investigation: result.ok ? result.config : {} }));
			assert.ok(resolveInvestigationModel(luna.model, { PI_CODING_AGENT_DIR: dir }).ok);
			assert.ok(!resolveInvestigationModel(terra.model, { PI_CODING_AGENT_DIR: dir }).ok);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a default or allowlist entry outside the fast model set", () => {
		assert.ok(!validateInvestigationConfig({ allowedModels: [luna], defaultModel: terra.model }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "openai/gpt-5.6-sol" }] }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "fast/model", thinking: "medium" }] }).ok);
	});

	it("requires medium or deeper thinking for every investigation model", () => {
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: luna.model }] }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: luna.model, thinking: "low" }] }).ok);
		assert.ok(validateInvestigationConfig({ allowedModels: [{ model: luna.model, thinking: "high" }] }).ok);
	});

	it("rejects duplicate and malformed allowlist entries", () => {
		assert.ok(!validateInvestigationConfig({ allowedModels: [luna, luna] }).ok);
		assert.ok(!validateInvestigationConfig({ allowedModels: [{ model: "not-a-model" }] }).ok);
	});

	it("prints the resolved model spec and rejects bad CLI arguments", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-investigation-cli-"));
		try {
			writeFileSync(
				join(dir, "kstack.json"),
				JSON.stringify({ investigation: { allowedModels: [luna], defaultModel: luna.model } }),
			);
			const env = { ...process.env, PI_CODING_AGENT_DIR: dir };
			const defaultRun = spawnSync(process.execPath, [script], { encoding: "utf8", env });
			assert.equal(defaultRun.status, 0);
			assert.equal(defaultRun.stdout, "openai/gpt-5.6-luna:medium\n");

			const rejected = spawnSync(process.execPath, [script, "--model", terra.model], { encoding: "utf8", env });
			assert.equal(rejected.status, 2);
			assert.match(rejected.stderr, /not in investigation\.allowedModels/);

			const missing = spawnSync(process.execPath, [script, "--model"], { encoding: "utf8", env });
			assert.equal(missing.status, 2);
			assert.match(missing.stderr, /--model requires/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
