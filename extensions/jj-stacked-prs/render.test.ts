import assert from "node:assert/strict";
import test from "node:test";
import { emptyStackLandProgress } from "../shared/stack/outcome.ts";
import { renderLandOutcome, renderOutcome, renderStackLandingPlan } from "./render.ts";

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

test("completed publication prompts a voice-aware rewrite for new drafts", () => {
	const rendered = renderOutcome({
		status: "completed",
		planId: "plan",
		publication: {
			topRef: "feature",
			pullRequests: [
				{ ref: "feature", baseRef: "main", prNumber: 42, url: "https://example.test/pull/42", draft: true },
			],
		},
		completedActions: [{ kind: "create-draft-pr", ref: "feature", prNumber: 42, url: "https://example.test/pull/42" }],
	});
	assert.match(rendered, /Immediately rewrite each new draft's title and body with the write-pr skill/);
	assert.match(rendered, /my-voice skill/);
});

test("partial publication prompts a rewrite only when a draft was created", () => {
	const partial = {
		status: "partial" as const,
		planId: "plan",
		failedAction: { kind: "repair-pr-base" as const, error: "base update failed" },
	};
	assert.doesNotMatch(renderOutcome({ ...partial, completedActions: [] }), /Immediately rewrite/);
	assert.match(
		renderOutcome({
			...partial,
			completedActions: [
				{ kind: "create-draft-pr", ref: "feature", prNumber: 42, url: "https://example.test/pull/42" },
			],
			publication: {
				topRef: "feature",
				pullRequests: [
					{
						ref: "feature",
						baseRef: "main",
						prNumber: 42,
						url: "https://example.test/pull/42",
						draft: true,
					},
				],
			},
		}),
		/Immediately rewrite/,
	);
});

test("cancelled and failed outcomes retain accumulated warnings", () => {
	assert.match(
		renderLandOutcome({
			status: "cancelled",
			...emptyStackLandProgress(),
			warnings: ["remote branch cleanup failed"],
		}),
		/Warnings:\n- remote branch cleanup failed/,
	);
	assert.match(
		renderLandOutcome({
			status: "failed",
			error: "landing failed",
			...emptyStackLandProgress(),
			warnings: ["earlier cleanup warning"],
		}),
		/Warnings:\n- earlier cleanup warning/,
	);
});
