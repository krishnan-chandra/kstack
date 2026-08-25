import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getArgumentCompletions, parseArgs, tokenize } from "./args.ts";

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
	it("parses --pr with positional intent", () => {
		const r = parseArgs(`--pr 42 Add safe archival`);
		assert.ok(r.ok);
		assert.equal(r.args.pr, 42);
		assert.equal(r.args.intent, "Add safe archival");
	});
	it("supports --pr=value form", () => {
		const r = parseArgs("--pr=42");
		assert.ok(r.ok);
		assert.equal(r.args.pr, 42);
	});
	it("rejects non-numeric, negative, and zero --pr values", () => {
		assert.ok(!parseArgs("--pr abc").ok);
		assert.ok(!parseArgs("--pr 0").ok);
		assert.ok(!parseArgs("--pr -5").ok);
		assert.ok(!parseArgs("--pr 3.14").ok);
		assert.ok(!parseArgs("--pr=").ok);
		assert.ok(!parseArgs("--pr").ok);
	});
	it("rejects combining --pr and --base", () => {
		const r = parseArgs("--pr 42 --base main Intent");
		assert.ok(!r.ok);
		assert.match(r.error, /mutually exclusive/);
	});
	it("rejects unknown flags", () => {
		assert.ok(!parseArgs("--verbose").ok);
	});
	it("rejects missing and empty flag values", () => {
		assert.ok(!parseArgs("--base").ok);
		assert.ok(!parseArgs("--base=").ok);
	});
});

describe("getArgumentCompletions", () => {
	it("offers flags at the start", () => {
		const expected = [
			{ value: "--base", label: "--base" },
			{ value: "--base=", label: "--base=" },
			{ value: "--pr", label: "--pr" },
			{ value: "--pr=", label: "--pr=" },
		];
		assert.deepEqual(getArgumentCompletions(""), expected);
		assert.deepEqual(getArgumentCompletions("--"), expected);
	});
	it("filters by the partial flag being typed", () => {
		assert.deepEqual(getArgumentCompletions("--b"), [
			{ value: "--base", label: "--base" },
			{ value: "--base=", label: "--base=" },
		]);
		assert.deepEqual(getArgumentCompletions("--p"), [
			{ value: "--pr", label: "--pr" },
			{ value: "--pr=", label: "--pr=" },
		]);
		assert.equal(getArgumentCompletions("--x"), null);
	});
	it("does not complete the free-form --base or --pr value", () => {
		assert.equal(getArgumentCompletions("--base "), null);
		assert.equal(getArgumentCompletions("--base main"), null);
		assert.equal(getArgumentCompletions("--base="), null);
		assert.equal(getArgumentCompletions("--base=main"), null);
		assert.equal(getArgumentCompletions("--pr "), null);
		assert.equal(getArgumentCompletions("--pr 42"), null);
		assert.equal(getArgumentCompletions("--pr="), null);
		assert.equal(getArgumentCompletions("--pr=42"), null);
	});
	it("stops offering flags once the positional intent has started", () => {
		assert.equal(getArgumentCompletions("Add safe archival --"), null);
		assert.equal(getArgumentCompletions("--base main Add safe archival --"), null);
	});
	it("leaves the free-form intent untouched with no --base present", () => {
		assert.equal(getArgumentCompletions("Add safe archival"), null);
	});
});
