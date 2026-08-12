import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPanelArg, buildPanelArgs } from "./format.ts";

describe("formatPanelArg", () => {
	it("wraps value in double quotes", () => {
		assert.equal(formatPanelArg("hello"), '"hello"');
	});

	it("escapes embedded double quotes", () => {
		assert.equal(formatPanelArg('say "hello"'), '"say \\"hello\\""');
	});

	it("replaces newlines with spaces", () => {
		assert.equal(formatPanelArg("line1\nline2"), '"line1 line2"');
	});

	it("replaces carriage returns with spaces", () => {
		assert.equal(formatPanelArg("line1\rline2"), '"line1 line2"');
	});

	it("collapses multiple whitespace", () => {
		assert.equal(formatPanelArg("hello    world"), '"hello world"');
	});

	it("handles backslashes", () => {
		assert.equal(formatPanelArg("path\\to\\file"), '"path\\\\to\\\\file"');
	});

	it("trims whitespace", () => {
		assert.equal(formatPanelArg("  hello  "), '"hello"');
	});

	it("handles empty string", () => {
		assert.equal(formatPanelArg(""), '""');
	});
});

describe("buildPanelArgs", () => {
	it("builds --intent flag", () => {
		const r = buildPanelArgs({ intent: "Review the changes" });
		assert.ok(r.ok);
		if (r.ok) {
			assert.ok(r.args.includes('--intent "Review the changes"'));
		}
	});

	it("builds --base and --intent", () => {
		const r = buildPanelArgs({ intent: "Review changes", base: "main" });
		assert.ok(r.ok);
		if (r.ok) {
			assert.ok(r.args.includes('--base "main"'));
			assert.ok(r.args.includes('--intent "Review changes"'));
		}
	});

	it("rejects empty intent", () => {
		const r = buildPanelArgs({ intent: "" });
		assert.ok(!r.ok);
	});

	it("rejects empty base", () => {
		const r = buildPanelArgs({ intent: "Review", base: "" });
		assert.ok(!r.ok);
	});

	it("rejects unsafe base characters", () => {
		const r = buildPanelArgs({ intent: "Review", base: "main; rm -rf /" });
		assert.ok(!r.ok);
	});

	it("accepts base with dots, dashes, slashes", () => {
		const r = buildPanelArgs({ intent: "Review", base: "origin/main-v2.0" });
		assert.ok(r.ok);
	});

	it("handles special characters in intent", () => {
		const r = buildPanelArgs({ intent: 'Fix "critical" bug\nAdd tests' });
		assert.ok(r.ok);
		if (r.ok) {
			// Should contain escaped quotes.
			assert.ok(r.args.includes('\\"'));
			// Newlines should be spaces.
			assert.ok(!r.args.includes("\n"));
		}
	});

	it("bounds intent to 1000 characters", () => {
		const long = "x".repeat(2000);
		const r = buildPanelArgs({ intent: long });
		assert.ok(r.ok);
		if (r.ok) {
			// Should have at most 1000 + quote overhead.
			assert.ok(r.args.length < 1100);
		}
	});
});