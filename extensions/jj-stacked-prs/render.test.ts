import assert from "node:assert/strict";
import test from "node:test";
import { renderLandConfirmation } from "./render.ts";

const slices = [
	{
		bookmark: "feature",
		prNumber: 42,
		url: "https://example.test/pull/42",
		draft: false,
		alreadyMerged: false,
	},
];

test("watch confirmation discloses pre-authorized autopilot mutations", () => {
	const rendered = renderLandConfirmation({ slices, method: "squash", readiness: "watch" });
	assert.equal(rendered.ok, true);
	if (!rendered.ok) return;
	assert.match(
		rendered.body,
		/merge remote bases, rerun failed CI jobs, edit code, push fixes, and update review threads without more prompts/,
	);
});

test("check confirmation does not claim that readiness can mutate", () => {
	const rendered = renderLandConfirmation({ slices, method: "squash", readiness: "check" });
	assert.equal(rendered.ok, true);
	if (!rendered.ok) return;
	assert.doesNotMatch(rendered.body, /edit code/);
});
