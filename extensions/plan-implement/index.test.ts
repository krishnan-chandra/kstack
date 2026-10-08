import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getArgumentCompletions, parsePlanImplementArgs, validateTask } from "./command.ts";

describe("plan-implement command helpers", () => {
	it("validates empty and oversized tasks", () => {
		assert.equal(validateTask("  do it  ").ok, true);
		assert.equal(validateTask("   ").ok, false);
		assert.equal(validateTask("x".repeat(32 * 1024 + 1)).ok, false);
	});
});

describe("parsePlanImplementArgs", () => {
	it("defaults to single and leaves change kind for the UI to select", () => {
		const r = parsePlanImplementArgs("add caching layer");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.mode, "single");
			assert.equal(r.changeKind, undefined);
			assert.equal(r.task, "add caching layer");
		}
	});

	it("accepts delivery and change-kind flags in either order", () => {
		const stack = parsePlanImplementArgs("--change-kind feature --stack build a three-PR stack");
		assert.equal(stack.ok, true);
		if (stack.ok) {
			assert.equal(stack.mode, "stack");
			assert.equal(stack.changeKind, "feature");
			assert.equal(stack.task, "build a three-PR stack");
		}
		const single = parsePlanImplementArgs("--single --change-kind bug-fix fix the crash");
		assert.equal(single.ok, true);
		if (single.ok) {
			assert.equal(single.mode, "single");
			assert.equal(single.changeKind, "bug-fix");
			assert.equal(single.task, "fix the crash");
		}
	});

	it("treats empty arguments as a single run needing change-kind and task input", () => {
		const r = parsePlanImplementArgs("");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.mode, "single");
			assert.equal(r.changeKind, undefined);
			assert.equal(r.task, "");
		}
	});

	it("accepts explicit options without a task for the editor flow", () => {
		const r = parsePlanImplementArgs("--stack --change-kind refactor");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.mode, "stack");
			assert.equal(r.changeKind, "refactor");
			assert.equal(r.task, "");
		}
	});

	it("parses adversary and plan-only flags and rejects fast plan-only runs", () => {
		const parsed = parsePlanImplementArgs("--no-adversary --plan-only --change-kind feature Draft it");
		assert.ok(parsed.ok);
		assert.equal(parsed.adversary, false);
		assert.equal(parsed.planOnly, true);
		assert.equal(parsed.task, "Draft it");
		assert.equal(parsePlanImplementArgs("--fast --plan-only task").ok, false);
		assert.equal(parsePlanImplementArgs("--no-adversary --no-adversary task").ok, false);
	});

	it("accepts an explicit plan for fast and full runs", () => {
		const fast = parsePlanImplementArgs("--fast --plan-file /plans/approved.md implement it");
		assert.ok(fast.ok);
		if (fast.ok) {
			assert.equal(fast.planFile, "/plans/approved.md");
			assert.equal(fast.fast, true);
			assert.equal(fast.task, "implement it");
		}
		const full = parsePlanImplementArgs("--plan-file /plans/approved.md implement it");
		assert.ok(full.ok);
		if (full.ok) {
			assert.equal(full.planFile, "/plans/approved.md");
			assert.equal(full.fast, false);
			assert.equal(full.task, "implement it");
		}
		assert.equal(parsePlanImplementArgs("--plan-file /plans/a.md --plan-only task").ok, false);
		assert.equal(parsePlanImplementArgs("--fast --plan-file").ok, false);
		assert.equal(parsePlanImplementArgs("--fast --plan-file a --plan-file b task").ok, false);
	});

	it("accepts a managed worktree only with single delivery", () => {
		const r = parsePlanImplementArgs("--worktree --single --change-kind feature add search");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.workLocation, "worktree");
			assert.equal(r.task, "add search");
		}
		assert.equal(parsePlanImplementArgs("--stack --worktree add search").ok, false);
		assert.equal(parsePlanImplementArgs("--worktree --worktree add search").ok, false);
	});

	it("uses -- to allow a task that starts with dashes", () => {
		const r = parsePlanImplementArgs("--change-kind generic -- --task-with-dashes");
		assert.equal(r.ok, true);
		if (r.ok) assert.equal(r.task, "--task-with-dashes");
	});

	it("rejects conflicting, duplicate, invalid, and unknown flags", () => {
		assert.equal(parsePlanImplementArgs("--stack --single thing").ok, false);
		assert.equal(parsePlanImplementArgs("--change-kind feature --change-kind refactor thing").ok, false);
		assert.equal(parsePlanImplementArgs("--change-kind rewrite thing").ok, false);
		assert.equal(parsePlanImplementArgs("--bogus thing").ok, false);
	});
});

describe("getArgumentCompletions", () => {
	it("completes all flags at the start of the arguments", () => {
		assert.deepEqual(getArgumentCompletions(""), [
			{ value: "--single", label: "--single" },
			{ value: "--stack", label: "--stack" },
			{ value: "--worktree", label: "--worktree" },
			{ value: "--change-kind", label: "--change-kind" },
			{ value: "--fast", label: "--fast" },
			{ value: "--no-adversary", label: "--no-adversary" },
			{ value: "--plan-only", label: "--plan-only" },
			{ value: "--plan-file", label: "--plan-file" },
		]);
	});

	it("filters flags by the partial token being typed", () => {
		assert.deepEqual(getArgumentCompletions("--s"), [
			{ value: "--single", label: "--single" },
			{ value: "--stack", label: "--stack" },
		]);
		assert.deepEqual(getArgumentCompletions("--w"), [{ value: "--worktree", label: "--worktree" }]);
	});

	it("preserves earlier flags while completing a later flag", () => {
		assert.deepEqual(getArgumentCompletions("--single --w"), [{ value: "--single --worktree", label: "--worktree" }]);
	});

	it("completes change kinds after --change-kind, preserving preceding text", () => {
		assert.deepEqual(getArgumentCompletions("--change-kind "), [
			{ value: "--change-kind bug-fix", label: "bug-fix" },
			{ value: "--change-kind feature", label: "feature" },
			{ value: "--change-kind refactor", label: "refactor" },
			{ value: "--change-kind performance", label: "performance" },
			{ value: "--change-kind prototype", label: "prototype" },
			{ value: "--change-kind generic", label: "generic" },
		]);
		assert.deepEqual(getArgumentCompletions("--stack --change-kind bug"), [
			{ value: "--stack --change-kind bug-fix", label: "bug-fix" },
		]);
	});

	it("leaves free-form task text alone", () => {
		assert.equal(getArgumentCompletions("fix the login bug"), null);
		assert.equal(getArgumentCompletions("fix the bug --w"), null);
		assert.equal(getArgumentCompletions("--single fix the login bug"), null);
		assert.equal(getArgumentCompletions("--change-kind nonsense-kind"), null);
	});
});
