import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSlug, MAX_SLUG_LENGTH, normalizePathSegment } from "./slug.ts";

describe("extractSlug", () => {
	it("extracts keywords instead of restating the description", () => {
		assert.equal(
			extractSlug("Implement deterministic session naming for every delegated development workflow"),
			"implement-deterministic",
		);
		assert.equal(extractSlug("Please fix the archive picker in the panel"), "fix-archive-picker-panel");
		assert.equal(extractSlug("- Investigate the timeout"), "investigate-timeout");
	});

	it("uses the first content line only", () => {
		assert.equal(extractSlug("\n## Fix archive selection\nMore detail"), "fix-archive-selection");
	});

	it("strips Latin diacritics and drops non-ASCII text", () => {
		assert.equal(extractSlug("Crème brûlée: 日本語"), "creme-brulee");
		assert.equal(extractSlug("日本語"), "change");
		assert.equal(extractSlug("日本語", "development-task"), "development-task");
	});

	it("keeps stop words when they are all that remains", () => {
		assert.equal(extractSlug("the and of"), "the-and-of");
	});

	it("strips possessive 's instead of leaving an orphan s token", () => {
		assert.equal(extractSlug("Fix the user's permissions issue"), "fix-user-permissions-issue");
		assert.equal(extractSlug("Update the panel's layout"), "update-panel-layout");
	});

	it("treats the length target as soft and never cuts a word", () => {
		const long = extractSlug(
			"implement deterministic session naming for every delegated development workflow without replacing explicit names",
		);
		assert.ok(long.length <= MAX_SLUG_LENGTH);
		assert.doesNotMatch(long, /-$/);
		assert.equal(extractSlug("x".repeat(100)), "x".repeat(100));
	});

	it("falls back when nothing usable remains", () => {
		assert.equal(extractSlug("  \n  "), "change");
		assert.equal(extractSlug("!!!"), "change");
	});
});

describe("normalizePathSegment", () => {
	it("keeps every word of the real name, including stop words", () => {
		assert.equal(normalizePathSegment("my-project"), "my-project");
		assert.equal(normalizePathSegment("our-project"), "our-project");
		assert.equal(normalizePathSegment("The App"), "the-app");
	});

	it("stays ASCII-safe and falls back when empty", () => {
		assert.equal(normalizePathSegment("Crème Brûlée!"), "creme-brulee");
		assert.equal(normalizePathSegment("日本語"), "repo");
		assert.equal(normalizePathSegment("---"), "repo");
	});
});
