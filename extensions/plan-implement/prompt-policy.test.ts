import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

function readPrompt(name: string): string {
	return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

describe("plan-implement prompt policy", () => {
	const planner = readPrompt("planner.md");
	const implementer = readPrompt("implementer.md");
	const fixer = readPrompt("review-fixer.md");
	const publisher = readPrompt("publisher.md");

	it("requires a dedicated current-mode branch before the first edit", () => {
		assert.match(planner, /kstack\/<task-slug>/);
		assert.match(planner, /current `HEAD`/);
		assert.match(implementer, /create a dedicated `kstack\/<task-slug>` branch/);
		assert.match(implementer, /before the first edit/);
		assert.match(implementer, /numeric suffix/);
	});

	it("reuses a parent-created managed-worktree branch", () => {
		assert.match(planner, /managed worktree: verify and reuse/i);
		assert.match(implementer, /parent-created managed worktree/);
		assert.match(implementer, /Do not create a second branch/);
	});

	it("stops on a dirty current working tree", () => {
		assert.match(implementer, /refuse to carry a dirty tree/);
		assert.match(implementer, /tracked or untracked pre-existing changes/);
		assert.match(implementer, /recommend rerunning with `--worktree`/);
		assert.match(implementer, /Do not stash, move, discard, or commit those files/);
		assert.match(fixer, /unrelated pre-existing changes, stop and report them/);
	});

	it("requires incremental focused commits and forbids push or publication", () => {
		assert.match(planner, /coherent commit checkpoints/);
		assert.match(implementer, /Commit one coherent, reviewable milestone/);
		assert.match(implementer, /Stage only workstream files/);
		assert.match(implementer, /Finish with no uncommitted task changes/);
		assert.match(implementer, /Never push, publish, force-push, or create a PR/);
		assert.match(implementer, /ordered commit SHAs\/subjects/);
		assert.match(fixer, /Never push, publish, force-push, or create PRs/);
	});

	it("keeps review fixes on the existing branch and commits verified batches", () => {
		assert.match(fixer, /Stay on the existing workstream branch/);
		assert.match(fixer, /commit each independent, verified fix batch/);
		assert.match(fixer, /commits created \(SHA and subject\)/i);
	});

	it("stops publication when uncommitted workstream files remain", () => {
		assert.match(publisher, /If uncommitted files belong to the requested workstream, stop and report them/);
		assert.match(publisher, /do not publish an incomplete committed diff/i);
		assert.match(publisher, /Report unrelated uncommitted files without committing them/);
		assert.match(publisher, /never commit uncommitted work/);
	});

	it("does not tell implementer or fixer roles to skip local commits", () => {
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
