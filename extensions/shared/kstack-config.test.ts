import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAgentDir, getKstackPath, isThinkingLevel, loadKstackSection, MODEL_ID_RE } from "./kstack-config.ts";

describe("shared kstack config", () => {
	it("uses the default agent directory", () => assert.equal(getAgentDir({}), join(homedir(), ".pi", "agent")));
	it("honors absolute env overrides", () => assert.equal(getKstackPath({ PI_CODING_AGENT_DIR: "/agent" }), "/agent/kstack.json"));
	it("expands bare ~ and ~/ overrides", () => {
		assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "~" }), homedir());
		assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }), join(homedir(), "custom"));
	});
	it("loads found and missing sections", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-config-")); writeFileSync(join(dir, "kstack.json"), '{"one":{"ok":true}}');
		assert.equal(loadKstackSection("one", { PI_CODING_AGENT_DIR: dir }).status, "found");
		assert.equal(loadKstackSection("two", { PI_CODING_AGENT_DIR: dir }).status, "missing");
	});
	it("reports a missing file", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-config-")); assert.equal(loadKstackSection("one", { PI_CODING_AGENT_DIR: dir }).status, "missing");
	});
	it("rejects invalid JSON and non-object roots", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-config-")); const path = join(dir, "kstack.json");
		writeFileSync(path, "{"); assert.equal(loadKstackSection("one", { PI_CODING_AGENT_DIR: dir }).status, "invalid");
		writeFileSync(path, "[]"); const result = loadKstackSection("one", { PI_CODING_AGENT_DIR: dir }); assert.deepEqual(result, { status: "invalid", path, error: "kstack.json must be a JSON object." });
	});
	it("shares thinking and model predicates", () => { assert.equal(isThinkingLevel("xhigh"), true); assert.equal(isThinkingLevel("huge"), false); assert.equal(MODEL_ID_RE.test("openrouter/vendor/model"), true); });
});
