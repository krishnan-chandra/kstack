import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "./command.ts";

describe("pr-babysit command parser", () => {
	it("defaults to check mode with no arguments", () => {
		const result = parseArgs("");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.args.mode, "check");
			assert.equal(result.args.pr, undefined);
		}
	});

	it("accepts explicit --mode", () => {
		for (const mode of ["check", "threads", "drive", "cleanup"]) {
			const result = parseArgs(`--mode ${mode}`);
			assert.equal(result.ok, true, `mode ${mode} should parse`);
			if (result.ok) assert.equal(result.args.mode, mode);
		}
	});

	it("accepts --mode=shorthand", () => {
		const result = parseArgs("--mode=drive");
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.args.mode, "drive");
	});

	it("accepts --pr", () => {
		const result = parseArgs("--mode drive --pr 42");
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.args.mode, "drive");
			assert.equal(result.args.pr, 42);
		}
	});

	it("rejects unsupported repository overrides and positional text", () => {
		assert.equal(parseArgs("--repo owner/repo").ok, false);
		assert.equal(parseArgs("--mode drive watch CI").ok, false);
	});

	it("rejects invalid modes", () => {
		const result = parseArgs("--mode invalid");
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /check, threads, drive, cleanup/);
	});

	it("rejects non-integer and zero PR numbers", () => {
		assert.equal(parseArgs("--pr abc").ok, false);
		assert.equal(parseArgs("--pr 0").ok, false);
		assert.equal(parseArgs("--pr -5").ok, false);
		assert.equal(parseArgs("--pr 42x").ok, false);
	});

	it("rejects unknown flags", () => {
		const result = parseArgs("--bogus thing");
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /Unknown flag/);
	});

	it("rejects duplicate --mode", () => {
		const result = parseArgs("--mode check --mode drive");
		assert.equal(result.ok, false);
	});

	it("handles quoted arguments", () => {
		const result = parseArgs('--mode "check" --task "my task"');
		// --task is not a recognized flag
		assert.equal(result.ok, false);
	});

	it("accepts --pr with value attached", () => {
		const result = parseArgs("--pr=42");
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.args.pr, 42);
	});
});
