import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	getAgentDir,
	getKstackPath,
	isThinkingLevel,
	loadKstackSection,
	loadValidatedSection,
	MODEL_ID_RE,
	validateAdversaryConfig,
} from "./kstack-config.ts";
import { type BoundaryValue, isString } from "./validation.ts";

describe("shared kstack config", () => {
	it("uses the default agent directory", () => assert.equal(getAgentDir({}), join(homedir(), ".pi", "agent")));
	it("honors absolute env overrides", () =>
		assert.equal(getKstackPath({ PI_CODING_AGENT_DIR: "/agent" }), "/agent/kstack.json"));
	it("expands bare ~ and ~/ overrides", () => {
		assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "~" }), homedir());
		assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }), join(homedir(), "custom"));
	});
	it("loads found and missing sections", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-config-"));
		writeFileSync(join(dir, "kstack.json"), '{"one":{"ok":true}}');
		assert.equal(loadKstackSection("one", { PI_CODING_AGENT_DIR: dir }).status, "found");
		assert.equal(loadKstackSection("two", { PI_CODING_AGENT_DIR: dir }).status, "missing");
	});
	it("reports a missing file", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-config-"));
		assert.equal(loadKstackSection("one", { PI_CODING_AGENT_DIR: dir }).status, "missing");
	});
	it("loads validated sections and preserves load failures", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-config-"));
		const env = { PI_CODING_AGENT_DIR: dir };
		const path = join(dir, "kstack.json");
		const validate = (value: BoundaryValue) =>
			isString(value) ? { ok: true as const, config: value } : { ok: false as const, error: "must be a string" };

		writeFileSync(path, '{"valid":"ok","invalid":42}');
		assert.deepEqual(loadValidatedSection("valid", validate, env), { status: "loaded", config: "ok", path });
		assert.deepEqual(loadValidatedSection("missing", validate, env), { status: "missing", path });
		assert.deepEqual(loadValidatedSection("invalid", validate, env), {
			status: "invalid",
			path,
			error: "must be a string",
		});
		writeFileSync(path, "{");
		assert.equal(loadValidatedSection("valid", validate, env).status, "invalid");
	});
	it("rejects invalid JSON and non-object roots", () => {
		const dir = mkdtempSync(join(tmpdir(), "kstack-config-"));
		const path = join(dir, "kstack.json");
		writeFileSync(path, "{");
		assert.equal(loadKstackSection("one", { PI_CODING_AGENT_DIR: dir }).status, "invalid");
		writeFileSync(path, "[]");
		const result = loadKstackSection("one", { PI_CODING_AGENT_DIR: dir });
		assert.deepEqual(result, { status: "invalid", path, error: "kstack.json must be a JSON object." });
	});
	it("shares thinking and model predicates", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.equal(isThinkingLevel(level), true);
		}
		assert.equal(isThinkingLevel("medium-high"), false);
		assert.equal(isThinkingLevel(""), false);
		assert.equal(isThinkingLevel(42), false);
		assert.equal(MODEL_ID_RE.test("openrouter/vendor/model"), true);
	});
});

function adversaryError(value: BoundaryValue): string {
	const result = validateAdversaryConfig(value);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected adversary validation to fail");
	return result.error;
}

describe("validateAdversaryConfig", () => {
	it("accepts an object model and applies defaults", () => {
		assert.deepEqual(validateAdversaryConfig({ adversary: { model: "openai/gpt-6-astra", thinking: "medium" } }), {
			ok: true,
			config: {
				adversaries: [{ model: "openai/gpt-6-astra", thinking: "medium" }],
				maxRounds: 3,
				timeoutMinutes: 15,
				reviewTimeoutMinutes: 10,
			},
		});
	});

	it("falls back to the built-in adversary and accepts multiple entries", () => {
		assert.deepEqual(validateAdversaryConfig({}), {
			ok: true,
			config: {
				adversaries: [{ model: "openai/gpt-6-astra", thinking: "medium" }],
				maxRounds: 3,
				timeoutMinutes: 15,
				reviewTimeoutMinutes: 10,
			},
		});
		assert.deepEqual(validateAdversaryConfig({ adversary: [{ model: "openai/gpt-6-astra" }, "fable"] }), {
			ok: true,
			config: {
				adversaries: [{ model: "openai/gpt-6-astra" }, "fable"],
				maxRounds: 3,
				timeoutMinutes: 15,
				reviewTimeoutMinutes: 10,
			},
		});
	});

	it("accepts an alias and explicit bounds", () => {
		assert.deepEqual(
			validateAdversaryConfig({
				adversary: "fable",
				maxRounds: 5,
				timeoutMinutes: 60,
				reviewTimeoutMinutes: 20,
			}),
			{
				ok: true,
				config: { adversaries: ["fable"], maxRounds: 5, timeoutMinutes: 60, reviewTimeoutMinutes: 20 },
			},
		);
	});

	it("rejects malformed models and aliases", () => {
		assert.match(adversaryError({ adversary: {} }), /model/);
		assert.match(adversaryError({ adversary: "not an alias" }), /alias/);
		assert.match(adversaryError({ adversary: { model: "astra", thinking: "medium" } }), /provider\/model/);
		assert.match(adversaryError({ adversary: { model: "openai/astra", thinking: "enormous" } }), /thinking/);
		assert.match(adversaryError({ adversary: [] }), /1 to 5/);
	});

	it("accepts five adversaries, rejects six, and indexes malformed later entries", () => {
		const five = [{ model: "a/b" }, { model: "c/d" }, { model: "e/f" }, { model: "g/h" }, { model: "i/j" }];
		assert.equal(validateAdversaryConfig({ adversary: five }).ok, true);
		assert.match(adversaryError({ adversary: [...five, { model: "k/l" }] }), /1 to 5/);
		assert.match(adversaryError({ adversary: [{ model: "a/b" }, {}] }), /adversary\.adversary\[1\]\.model/);
		assert.match(
			adversaryError({ adversary: [{ model: "a/b" }, { model: "c/d", thinking: "enormous" }] }),
			/adversary\.adversary\[1\]\.thinking/,
		);
	});

	it("rejects round and timeout values outside their integer bounds", () => {
		for (const maxRounds of [0, 6, 1.5]) {
			assert.match(adversaryError({ adversary: "fable", maxRounds }), /maxRounds/);
		}
		for (const timeoutMinutes of [0, 61, 1.5]) {
			assert.match(adversaryError({ adversary: "fable", timeoutMinutes }), /timeoutMinutes/);
		}
		for (const reviewTimeoutMinutes of [0, 61, 1.5]) {
			assert.match(adversaryError({ adversary: "fable", reviewTimeoutMinutes }), /reviewTimeoutMinutes/);
		}
	});
});
