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
