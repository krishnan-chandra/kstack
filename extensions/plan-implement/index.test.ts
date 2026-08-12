import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../panel-review/args.ts";
import { buildPanelReviewArgs, validateTask } from "./command.ts";

describe("plan-implement command helpers", () => {
	it("validates empty and oversized tasks", () => {
		assert.equal(validateTask("  do it  ").ok, true);
		assert.equal(validateTask("   ").ok, false);
		assert.equal(validateTask("x".repeat(32 * 1024 + 1)).ok, false);
	});

	it("quotes panel intent so task flags and quotes remain data", () => {
		const args = buildPanelReviewArgs('add "safe" mode --base evil; /other \\ path\nnext');
		const parsed = parseArgs(args);
		assert.equal(parsed.ok, true);
		if (parsed.ok) {
			assert.equal(parsed.args.base, undefined);
			assert.equal(parsed.args.intent, 'Plan/implement: add "safe" mode --base evil; /other ∖ path next');
		}
	});

	it("bounds panel intent", () => {
		const args = buildPanelReviewArgs("x".repeat(2000));
		const parsed = parseArgs(args);
		assert.equal(parsed.ok, true);
		if (parsed.ok) assert.equal(parsed.args.intent?.length, "Plan/implement: ".length + 1000);
	});
});
