import assert from "node:assert/strict";
import test from "node:test";
import type { StackPublicationMap } from "./outcome.ts";
import { createPublicationProgress } from "./publication-progress.ts";

const publication: StackPublicationMap = {
	topRef: "feature",
	pullRequests: [{ ref: "feature", baseRef: "main", prNumber: 42, url: "https://example.test/pull/42", draft: true }],
};

test("classifies cancellation before and after completed progress", () => {
	const empty = createPublicationProgress({ planId: "plan", topRef: "feature", pullRequests: () => [] });
	assert.deepEqual(empty.cancelled({ kind: "push-bookmark", ref: "feature", error: "cancelled" }), {
		status: "cancelled",
	});

	const progressed = createPublicationProgress({
		planId: "plan",
		topRef: publication.topRef,
		pullRequests: () => publication.pullRequests,
	});
	progressed.completed({ kind: "push-bookmark", ref: "feature" });
	assert.deepEqual(progressed.cancelled({ kind: "create-draft-pr", ref: "feature", error: "cancelled" }), {
		status: "partial",
		planId: "plan",
		completedActions: [{ kind: "push-bookmark", ref: "feature" }],
		publication,
		failedAction: { kind: "create-draft-pr", ref: "feature", error: "cancelled" },
	});
});

test("classifies conclusive and indeterminate failures with current evidence", () => {
	const progress = createPublicationProgress({
		planId: "plan",
		topRef: publication.topRef,
		pullRequests: () => publication.pullRequests,
	});
	const failed = { kind: "create-draft-pr" as const, ref: "feature", error: "rejected" };
	assert.deepEqual(progress.failed(failed), { status: "failed", error: "rejected", completedActions: [] });

	progress.completed({ kind: "push-bookmark", ref: "feature" });
	assert.deepEqual(progress.failed(failed), {
		status: "partial",
		planId: "plan",
		completedActions: [{ kind: "push-bookmark", ref: "feature" }],
		publication,
		failedAction: failed,
	});
	assert.deepEqual(progress.indeterminate(failed, "Inspect remote state."), {
		status: "indeterminate",
		planId: "plan",
		inFlight: failed,
		completedActions: [{ kind: "push-bookmark", ref: "feature" }],
		publication,
		recovery: "Inspect remote state.",
	});
});
