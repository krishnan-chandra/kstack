import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateVcsMode } from "./vcs-mode.ts";

describe("plan-implement VCS mode matrix", () => {
	it("allows Git single delivery in the checkout or a managed worktree", () => {
		assert.equal(validateVcsMode("git", "single", "current"), undefined);
		assert.equal(validateVcsMode("git", "single", "worktree"), undefined);
	});

	it("allows Graphite single delivery in the checkout or a managed worktree", () => {
		assert.equal(validateVcsMode("graphite", "single", "current"), undefined);
		assert.equal(validateVcsMode("graphite", "single", "worktree"), undefined);
	});

	it("allows jj single delivery only in the current workspace", () => {
		assert.equal(validateVcsMode("jj", "single", "current"), undefined);
		assert.match(validateVcsMode("jj", "single", "worktree") ?? "", /requires the Git or Graphite backend/);
	});

	it("allows stack delivery with jj or Graphite and without worktree isolation", () => {
		assert.equal(validateVcsMode("jj", "stack", "current"), undefined);
		assert.equal(validateVcsMode("graphite", "stack", "current"), undefined);
		assert.match(validateVcsMode("git", "stack", "current") ?? "", /requires the jj or Graphite backend/);
		assert.match(validateVcsMode("jj", "stack", "worktree") ?? "", /cannot currently be combined/);
		assert.match(validateVcsMode("graphite", "stack", "worktree") ?? "", /cannot currently be combined/);
	});
});
