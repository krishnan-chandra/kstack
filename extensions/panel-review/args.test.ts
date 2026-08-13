import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, tokenize } from "./args.ts";

describe("tokenize", () => {
	it("splits on whitespace and honors quotes", () => {
		assert.deepEqual(tokenize(`--base main --intent "hello world"`), ["--base", "main", "--intent", "hello world"]);
		assert.deepEqual(tokenize(`--intent 'a b'`), ["--intent", "a b"]);
	});
	it("reports unterminated quotes", () => {
		assert.ok(!Array.isArray(tokenize(`--intent "oops`)));
	});
});

describe("parseArgs", () => {
	it("accepts empty input", () => {
		assert.deepEqual(parseArgs(""), { ok: true, args: {} });
	});
	it("parses --base and --intent in any order", () => {
		const r = parseArgs(`--intent "Add safe archival" --base origin/main`);
		assert.ok(r.ok);
		assert.equal(r.args.base, "origin/main");
		assert.equal(r.args.intent, "Add safe archival");
	});
	it("supports --flag=value form", () => {
		const r = parseArgs("--base=main");
		assert.ok(r.ok);
		assert.equal(r.args.base, "main");
	});
	it("rejects unknown flags and positionals", () => {
		assert.ok(!parseArgs("--verbose").ok);
		assert.ok(!parseArgs("main").ok);
	});
	it("rejects missing and empty values", () => {
		assert.ok(!parseArgs("--base").ok);
		assert.ok(!parseArgs("--base=").ok);
	});
});

describe("parseArgs --mode / --thermo", () => {
	it("accepts --mode standard and --mode thermo", () => {
		const a = parseArgs("--mode standard");
		assert.ok(a.ok);
		assert.equal(a.args.mode, "standard");
		const b = parseArgs("--mode thermo");
		assert.ok(b.ok);
		assert.equal(b.args.mode, "thermo");
	});
	it("supports --mode=value form", () => {
		const r = parseArgs("--mode=thermo");
		assert.ok(r.ok);
		assert.equal(r.args.mode, "thermo");
	});
	it("accepts plain --thermo shorthand", () => {
		const r = parseArgs("--thermo");
		assert.ok(r.ok);
		assert.equal(r.args.mode, "thermo");
	});
	it("last flag wins for --mode / --thermo", () => {
		const a = parseArgs("--mode standard --thermo");
		assert.ok(a.ok);
		assert.equal(a.args.mode, "thermo");
		const b = parseArgs("--thermo --mode standard");
		assert.ok(b.ok);
		assert.equal(b.args.mode, "standard");
	});
	it("rejects invalid --mode values", () => {
		const r = parseArgs("--mode turbo");
		assert.ok(!r.ok);
		if (!r.ok) assert.match(r.error, /must be one of/);
	});
	it("rejects --thermo with a value", () => {
		const r = parseArgs("--thermo standard");
		// "standard" is not a flag; it is a positional after --thermo and is rejected.
		// The dedicated value-rejection path is --thermo=xxx.
		assert.ok(!r.ok);
		const s = parseArgs("--thermo=foo");
		assert.ok(!s.ok);
		if (!s.ok) assert.match(s.error, /does not take a value/);
	});
	it("combines --mode with --base and --intent", () => {
		const r = parseArgs(`--base main --intent "fix it" --mode thermo`);
		assert.ok(r.ok);
		assert.equal(r.args.base, "main");
		assert.equal(r.args.intent, "fix it");
		assert.equal(r.args.mode, "thermo");
	});
});
