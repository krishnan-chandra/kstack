import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assembleReviewerPrompt } from "./run-phases.ts";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "prompts");

test("every reviewer receives the complete thermo-nuclear review mandate", () => {
	const contract = readFileSync(join(promptsDir, "reviewer.md"), "utf8");
	assert.match(contract, /Perform the full review yourself/);
	assert.match(contract, /Inspect the entire changeset/);
	assert.match(contract, /Do not partition the\s+review/);
	assert.match(contract, /Redundant full coverage across reviewers is\s+intentional/);
});

test("the assembled reviewer prompt contains every full-review policy", () => {
	const prompt = assembleReviewerPrompt();
	for (const heading of [
		"# Reviewer Contract",
		"# Review Rubric",
		"# Code Quality Review Lens",
		"# Thermo-Nuclear Code Quality Review",
	]) {
		assert.match(prompt, new RegExp(heading));
	}
});
