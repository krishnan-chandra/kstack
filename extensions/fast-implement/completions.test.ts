import assert from "node:assert/strict";
import { test } from "node:test";
import { getArgumentCompletions } from "./completions.ts";

test("suggests both flags on an empty prefix", () => {
	const items = getArgumentCompletions("");
	assert.ok(items);
	assert.deepEqual(
		items?.map((item) => item.value),
		["--worktree ", "--change-kind "],
	);
});

test("filters flags by the partial token being typed", () => {
	const items = getArgumentCompletions("--work");
	assert.deepEqual(
		items?.map((item) => item.value),
		["--worktree "],
	);
});

test("does not repeat a flag already present", () => {
	const items = getArgumentCompletions("--worktree --");
	assert.deepEqual(
		items?.map((item) => item.value),
		["--worktree --change-kind "],
	);
	assert.equal(getArgumentCompletions("--worktree --worktree"), null);
});

test("completes change-kind values and preserves preceding flag text", () => {
	const items = getArgumentCompletions("--worktree --change-kind ");
	assert.ok(items);
	assert.deepEqual(
		items?.map((item) => item.value).sort(),
		[
			"--worktree --change-kind bug-fix ",
			"--worktree --change-kind feature ",
			"--worktree --change-kind generic ",
			"--worktree --change-kind performance ",
			"--worktree --change-kind prototype ",
			"--worktree --change-kind refactor ",
		].sort(),
	);
});

test("filters change-kind values by the partial token being typed", () => {
	const items = getArgumentCompletions("--change-kind bu");
	assert.deepEqual(
		items?.map((item) => item.value),
		["--change-kind bug-fix "],
	);
});

test("offers a later flag once a value is complete, preserving preceding text", () => {
	const items = getArgumentCompletions("--change-kind feature --");
	assert.deepEqual(
		items?.map((item) => item.value),
		["--change-kind feature --worktree "],
	);
});

test("returns null once free-form task text has started", () => {
	assert.equal(getArgumentCompletions("Fix the "), null);
	assert.equal(getArgumentCompletions("Fix the login bug"), null);
	assert.equal(getArgumentCompletions("--worktree Fix the login bug"), null);
});

test("returns null for an unknown flag or change-kind value", () => {
	assert.equal(getArgumentCompletions("--stack"), null);
	assert.equal(getArgumentCompletions("--change-kind nope --"), null);
});
