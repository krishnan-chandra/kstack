import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildPanelReviewOptions,
	buildStackPanelReviewOptions,
	parsePlanImplementArgs,
	validateTask,
} from "./command.ts";

describe("plan-implement command helpers", () => {
	it("validates empty and oversized tasks", () => {
		assert.equal(validateTask("  do it  ").ok, true);
		assert.equal(validateTask("   ").ok, false);
		assert.equal(validateTask("x".repeat(32 * 1024 + 1)).ok, false);
	});

	it("keeps task text as structured panel intent", () => {
		const options = buildPanelReviewOptions('add "safe" mode --base evil; /other \\ path\nnext');
		assert.deepEqual(options, {
			intent: 'Plan/implement: add "safe" mode --base evil; /other \\ path next',
		});
	});

	it("bounds panel intent", () => {
		const options = buildPanelReviewOptions("x".repeat(2000));
		assert.equal(options.intent?.length, "Plan/implement: ".length + 1000);
	});

	it("passes the approved plan and implementer ledger to panel review", () => {
		assert.deepEqual(buildPanelReviewOptions("task", "approved plan", "## Execution Ledger\n- [STEP-1] task — done"), {
			intent: "Plan/implement: task",
			approvedPlan: "approved plan",
			executionLedger: "## Execution Ledger\n- [STEP-1] task — done",
		});
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

describe("buildStackPanelReviewOptions", () => {
	it("passes the immutable trunk SHA and tags the intent as stacked", () => {
		const options = buildStackPanelReviewOptions(
			'add "safe" mode; rm -rf /',
			"0123456789abcdef0123456789abcdef01234567",
		);
		assert.deepEqual(options, {
			base: "0123456789abcdef0123456789abcdef01234567",
			intent: 'Plan/implement (stacked): add "safe" mode; rm -rf /',
		});
	});

	it("bounds the intent", () => {
		const options = buildStackPanelReviewOptions("x".repeat(2000), "0123456789abcdef0123456789abcdef01234567");
		assert.equal(options.intent?.length, "Plan/implement (stacked): ".length + 1000);
	});
});
