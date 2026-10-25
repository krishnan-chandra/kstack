import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	getAgentDir,
	getKstackPath,
	isThinkingLevel,
	loadCouncilSection,
	loadKstackSection,
	loadValidatedSection,
	MODEL_ID_RE,
	validateCouncilConfig,
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

function councilError(value: BoundaryValue): string {
	const result = validateCouncilConfig(value);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected council validation to fail");
	return result.error;
}

const DEFAULTS = { maxRounds: 3, timeoutMinutes: 15, reviewTimeoutMinutes: 10 };

describe("validateCouncilConfig", () => {
	it("accepts seat objects and aliases and applies defaults", () => {
		assert.deepEqual(validateCouncilConfig({ seats: [{ model: "openai/gpt-6-astra", thinking: "medium" }, "argon"] }), {
			ok: true,
			config: { seats: [{ model: "openai/gpt-6-astra", thinking: "medium" }, "argon"], ...DEFAULTS },
		});
	});

	it("falls back to the built-in seat when seats is omitted", () => {
		assert.deepEqual(validateCouncilConfig({}), {
			ok: true,
			config: { seats: [{ model: "openai/gpt-6-astra", thinking: "xhigh" }], ...DEFAULTS },
		});
	});

	it("accepts explicit bounds", () => {
		assert.deepEqual(
			validateCouncilConfig({ seats: ["opus"], maxRounds: 5, timeoutMinutes: 60, reviewTimeoutMinutes: 20 }),
			{ ok: true, config: { seats: ["opus"], maxRounds: 5, timeoutMinutes: 60, reviewTimeoutMinutes: 20 } },
		);
	});

	it("rejects malformed seats", () => {
		assert.match(councilError([]), /council must be an object/);
		assert.match(councilError({ seats: "opus" }), /array of 1 to 5/);
		assert.match(councilError({ seats: [] }), /array of 1 to 5/);
		assert.match(councilError({ seats: [{}] }), /council\.seats\[0\]\.model/);
		assert.match(councilError({ seats: ["not an alias"] }), /alias/);
		assert.match(councilError({ seats: [{ model: "astra" }] }), /provider\/model/);
		assert.match(
			councilError({ seats: [{ model: "a/b" }, { model: "c/d", thinking: "enormous" }] }),
			/seats\[1\]\.thinking/,
		);
	});

	it("accepts five seats and rejects six", () => {
		const five = [{ model: "a/b" }, { model: "c/d" }, { model: "e/f" }, { model: "g/h" }, { model: "i/j" }];
		assert.equal(validateCouncilConfig({ seats: five }).ok, true);
		assert.match(councilError({ seats: [...five, { model: "k/l" }] }), /1 to 5/);
	});

	it("rejects round and timeout values outside their integer bounds", () => {
		for (const maxRounds of [0, 6, 1.5]) assert.match(councilError({ maxRounds }), /maxRounds/);
		for (const timeoutMinutes of [0, 61, 1.5]) assert.match(councilError({ timeoutMinutes }), /timeoutMinutes/);
		for (const reviewTimeoutMinutes of [0, 61, 1.5]) {
			assert.match(councilError({ reviewTimeoutMinutes }), /reviewTimeoutMinutes/);
		}
	});
});

describe("loadCouncilSection", () => {
	function load(root: BoundaryValue) {
		const dir = mkdtempSync(join(tmpdir(), "kstack-council-"));
		writeFileSync(join(dir, "kstack.json"), JSON.stringify(root));
		return loadCouncilSection({ PI_CODING_AGENT_DIR: dir });
	}

	it("loads a valid section with the root for alias resolution", () => {
		const result = load({ council: { seats: ["opus"] }, aliases: [] });
		assert.equal(result.status, "found");
		if (result.status !== "found") return;
		assert.deepEqual(result.config.seats, ["opus"]);
		assert.deepEqual(result.root.aliases, []);
	});

	it("reports a missing section and a missing file", () => {
		assert.equal(load({}).status, "missing");
		const empty = mkdtempSync(join(tmpdir(), "kstack-council-"));
		assert.equal(loadCouncilSection({ PI_CODING_AGENT_DIR: empty }).status, "missing");
	});

	it("rejects an invalid section", () => {
		const result = load({ council: { seats: [] } });
		assert.equal(result.status, "invalid");
	});

	it("rejects a legacy adversary section with a migration message", () => {
		for (const root of [{ adversary: { adversary: "astra" } }, { adversary: {}, council: { seats: ["opus"] } }]) {
			const result = load(root);
			assert.equal(result.status, "invalid");
			if (result.status !== "invalid") return;
			assert.match(result.error, /"adversary" to "council"/);
			assert.match(result.error, /council\.seats/);
		}
	});
});
