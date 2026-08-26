import assert from "node:assert/strict";
import test from "node:test";
import { renderLandOutcome, renderStackLandingPlan } from "./render.ts";

const slices = [
	{
		bookmark: "feature",
		prNumber: 42,
		url: "https://example.test/pull/42",
		draft: false,
		alreadyMerged: false,
	},
];

test("watch confirmation reports change and PR slice counts and discloses autopilot mutations", () => {
	const rendered = renderStackLandingPlan({ changeCount: 2, slices, method: "squash", readiness: "watch" });
	assert.equal(rendered.ok, true);
	if (!rendered.ok) return;
	assert.match(rendered.body, /2 jj changes → 1 PR slice/);
	assert.match(
		rendered.body,
		/merge remote bases, rerun failed CI jobs, edit code, push fixes, and update review threads without more prompts/,
	);
});

test("check confirmation does not claim that readiness can mutate", () => {
	const rendered = renderStackLandingPlan({ changeCount: 1, slices, method: "squash", readiness: "check" });
	assert.equal(rendered.ok, true);
	if (!rendered.ok) return;
	assert.doesNotMatch(rendered.body, /edit code/);
});

test("cancelled and failed outcomes retain accumulated warnings", () => {
	assert.match(
		renderLandOutcome({ status: "cancelled", warnings: ["remote branch cleanup failed"] }),
		/Warnings:\n- remote branch cleanup failed/,
	);
	assert.match(
		renderLandOutcome({ status: "failed", error: "landing failed", warnings: ["earlier cleanup warning"] }),
		/Warnings:\n- earlier cleanup warning/,
	);
});
