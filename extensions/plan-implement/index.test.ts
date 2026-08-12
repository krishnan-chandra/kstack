import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPanelReviewOptions, buildStackPanelReviewOptions, parseDeliveryMode, validateTask } from "./command.ts";

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
});

describe("parseDeliveryMode", () => {
	it("defaults to single with the whole string as task when no flag is present", () => {
		const r = parseDeliveryMode("add caching layer");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.mode, "single");
			assert.equal(r.task, "add caching layer");
		}
	});

	it("parses --stack and --single and strips the flag from the task", () => {
		const stack = parseDeliveryMode("--stack build a three-PR stack");
		assert.equal(stack.ok, true);
		if (stack.ok) {
			assert.equal(stack.mode, "stack");
			assert.equal(stack.task, "build a three-PR stack");
		}
		const single = parseDeliveryMode("--single just one PR");
		assert.equal(single.ok, true);
		if (single.ok) {
			assert.equal(single.mode, "single");
			assert.equal(single.task, "just one PR");
		}
	});

	it("treats an empty argument string as a single run with no task", () => {
		const r = parseDeliveryMode("");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.mode, "single");
			assert.equal(r.task, "");
		}
	});

	it("rejects a stack flag with no task as a stack run needing the editor", () => {
		const r = parseDeliveryMode("--stack");
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.mode, "stack");
			assert.equal(r.task, "");
		}
	});

	it("rejects both flags and unknown leading flags", () => {
		assert.equal(parseDeliveryMode("--stack --single thing").ok, false);
		assert.equal(parseDeliveryMode("--bogus thing").ok, false);
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
		const options = buildStackPanelReviewOptions(
			"x".repeat(2000),
			"0123456789abcdef0123456789abcdef01234567",
		);
		assert.equal(options.intent?.length, "Plan/implement (stacked): ".length + 1000);
	});
});
