import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

function readPrompt(name: string): string {
	return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

describe("plan-implement prompt policy", () => {
	const planner = readPrompt("planner.md");
	const implementer = readPrompt("implementer.md");
	const fixer = readPrompt("review-fixer.md");
	const publisher = readPrompt("publisher.md");

	it("requires the parent-prepared workstream before the first edit", () => {
		assert.match(planner, /dedicated workstream prepared by the parent/);
		assert.match(planner, /Git in the current checkout/);
		assert.match(planner, /jj in the current workspace/);
		assert.match(implementer, /parent creates and selects a dedicated `kstack\/<task-slug>` workstream/);
		assert.match(implementer, /Do not create a second one/);
	});

	it("reuses a parent-created managed Git worktree", () => {
		assert.match(planner, /Git in a managed worktree/);
		assert.match(implementer, /reusing the prepared workstream/);
		assert.match(implementer, /Do not create a second one/);
	});

	it("applies dirty-tree rules only to Git mode", () => {
		assert.match(implementer, /In Git mode, if `git status`/);
		assert.match(implementer, /recommend rerunning with `--worktree`/);
		assert.match(implementer, /Do not stash, move, discard, or commit those files/);
		assert.match(implementer, /In jj mode, use jj's working-copy model/);
		assert.match(fixer, /In Git mode, if `git status`/);
	});

	it("requires incremental focused changes and forbids publication", () => {
		assert.match(planner, /change checkpoint as one reviewable, verified milestone/);
		assert.match(implementer, /Record one coherent, reviewable milestone/);
		assert.match(implementer, /Include only workstream files/);
		assert.match(implementer, /empty jj working-copy change/);
		assert.match(implementer, /Never push, publish, force-push, or create a PR/);
		assert.match(fixer, /Never push, publish, force-push, or create PRs/);
	});

	it("keeps review fixes on the existing branch or bookmark", () => {
		assert.match(fixer, /Stay on the existing workstream branch or bookmark/);
		assert.match(fixer, /record each independent, verified fix batch/);
		assert.match(fixer, /commits or jj changes created/);
	});

	it("publishes with only the selected backend", () => {
		assert.match(publisher, /Follow the parent `VCS backend` policy/);
		assert.match(publisher, /jj git push --bookmark/);
		assert.match(publisher, /Do not create a Git branch/);
		assert.match(publisher, /If unrecorded files belong to the requested workstream, stop and report them/);
		assert.match(publisher, /never record additional changes/);
	});

	it("authors every stacked PR from its exact slice diff", () => {
		assert.match(publisher, /Prepare metadata for every slice before mutation/);
		assert.match(publisher, /use `trunk\(\)` below the bottom slice/);
		assert.match(publisher, /Do not use jj change descriptions as PR bodies/);
		assert.match(publisher, /gh pr edit <slice-pr-number>/);
		assert.ok(
			publisher.indexOf("Prepare metadata for every slice before mutation") <
				publisher.indexOf("publish_stack.py apply"),
		);
	});

	it("does not tell implementer or fixer roles to skip local changes", () => {
		assert.doesNotMatch(implementer, /Do not commit, push, publish/);
		assert.doesNotMatch(fixer, /Do not commit, push, publish/);
		assert.doesNotMatch(implementer, /does not commit/);
		assert.doesNotMatch(fixer, /does not commit/);
	});

	it("treats stacked delivery as described jj changes rather than a Git task branch", () => {
		assert.match(planner, /Bookmark boundaries are the stacked equivalent of a task branch/);
		assert.match(implementer, /stacked equivalent of a task branch and incremental commits/);
		assert.match(implementer, /do not also create a Git task branch/);
		assert.match(fixer, /amend the slice each finding belongs to/);
	});
});
