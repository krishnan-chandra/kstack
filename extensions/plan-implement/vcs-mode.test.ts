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

	it("allows stack delivery with every backend and without worktree isolation", () => {
		for (const backend of ["git", "jj", "graphite"] as const) {
			assert.equal(validateVcsMode(backend, "stack", "current"), undefined);
			assert.match(validateVcsMode(backend, "stack", "worktree") ?? "", /cannot currently be combined/);
		}
	});
});
