import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, tokenize } from "./args.ts";

describe("tokenize", () => {
	it("splits on whitespace and honors quotes", () => {
		assert.deepEqual(tokenize(`--base main "hello world"`), ["--base", "main", "hello world"]);
		assert.deepEqual(tokenize(`'a b'`), ["a b"]);
	});
	it("reports unterminated quotes", () => {
		assert.ok(!Array.isArray(tokenize(`"oops`)));
	});
});

describe("parseArgs", () => {
	it("accepts empty input", () => {
		assert.deepEqual(parseArgs(""), { ok: true, args: {} });
	});
	it("parses --base with positional intent", () => {
		const r = parseArgs(`--base origin/main Add safe archival`);
		assert.ok(r.ok);
		assert.equal(r.args.base, "origin/main");
		assert.equal(r.args.intent, "Add safe archival");
	});
	it("parses --base with quoted positional intent", () => {
		const r = parseArgs(`--base origin/main "Add safe archival"`);
		assert.ok(r.ok);
		assert.equal(r.args.base, "origin/main");
		assert.equal(r.args.intent, "Add safe archival");
	});
	it("parses positional intent without --base", () => {
		const r = parseArgs(`Add safe archival`);
		assert.ok(r.ok);
		assert.equal(r.args.intent, "Add safe archival");
		assert.equal(r.args.base, undefined);
	});
	it("supports --base=value form", () => {
		const r = parseArgs("--base=main");
		assert.ok(r.ok);
		assert.equal(r.args.base, "main");
	});
	it("rejects unknown flags", () => {
		assert.ok(!parseArgs("--verbose").ok);
	});
	it("rejects missing and empty flag values", () => {
		assert.ok(!parseArgs("--base").ok);
		assert.ok(!parseArgs("--base=").ok);
	});
});
