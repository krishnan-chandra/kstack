import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	appendHandledReviewRecords,
	appendPendingReviewReply,
	filterHandledReviewItems,
	isOwnedReviewComment,
	reconcileLegacyPendingReplyIds,
	versionReviewItem,
} from "./review-handling.ts";
import { LIMITS, type ReviewCommentEvidence, type ReviewThread } from "./types.ts";

const evidence: ReviewCommentEvidence = {
	id: "PRRC_1",
	body: "Please rename this value.",
	updatedAt: "2026-09-06T00:00:00Z",
	author: "reviewer",
	path: "src/a.ts",
	line: 4,
};

function thread(source: ReviewThread["source"], version: string): ReviewThread {
	return {
		id: source === "review-thread" ? "PRRT_1" : "issue-comment-1",
		commenter: "reviewer",
		body: evidence.body,
		source,
		version,
	};
}

describe("review evidence versions", () => {
	it("is deterministic and changes for every represented evidence field", () => {
		const base = versionReviewItem("review-thread", "PRRT_1", [evidence]);
		assert.equal(base, versionReviewItem("review-thread", "PRRT_1", [evidence]));
		assert.notEqual(
			versionReviewItem("review-thread", "PRRT_1", [evidence, { ...evidence, id: "PRRC_2" }]),
			versionReviewItem("review-thread", "PRRT_1", [{ ...evidence, id: "PRRC_2" }, evidence]),
		);
		for (const changed of [
			{ ...evidence, id: "PRRC_2" },
			{ ...evidence, body: `${evidence.body} More.` },
			{ ...evidence, updatedAt: "2026-09-06T00:01:00Z" },
			{ ...evidence, author: "another-reviewer" },
			{ ...evidence, path: "src/b.ts" },
			{ ...evidence, line: 5 },
		]) {
			assert.notEqual(base, versionReviewItem("review-thread", "PRRT_1", [changed]));
		}
	});

	it("versions the full body beyond the triager clipping boundary", () => {
		const prefix = "x".repeat(LIMITS.threadBodyChars);
		const first = versionReviewItem("review-thread", "PRRT_1", [{ ...evidence, body: `${prefix}a` }]);
		const second = versionReviewItem("review-thread", "PRRT_1", [{ ...evidence, body: `${prefix}b` }]);
		assert.notEqual(first, second);
	});

	it("recognizes only explicit Kstack ownership markers", () => {
		assert.equal(isOwnedReviewComment("<!-- pr-autopilot -->\nAddressed."), true);
		assert.equal(isOwnedReviewComment("<!-- kstack-stack-nav -->\nNavigation"), true);
		assert.equal(isOwnedReviewComment("dependabot review without a marker"), false);
	});
});

describe("completed review handling", () => {
	const version = versionReviewItem("review-thread", "PRRT_1", [evidence]);

	it("suppresses only an unchanged ignored review thread", () => {
		const item = thread("review-thread", version);
		const ignored = [{ id: item.id, source: item.source, version, decision: "ignore" as const }];
		assert.deepEqual(filterHandledReviewItems([item], ignored), []);
		assert.deepEqual(filterHandledReviewItems([{ ...item, version: `${version}-edited` }], ignored), [
			{ ...item, version: `${version}-edited` },
		]);
	});

	it("keeps reopened fixed and dismissed review threads actionable", () => {
		const item = thread("review-thread", version);
		for (const decision of ["fix", "dismiss"] as const) {
			assert.deepEqual(filterHandledReviewItems([item], [{ id: item.id, source: item.source, version, decision }]), [
				item,
			]);
		}
	});

	it("suppresses an issue comment only for the completed version", () => {
		const item = thread("issue-comment", version);
		const handled = [{ id: item.id, source: item.source, version, decision: "fix" as const }];
		assert.deepEqual(filterHandledReviewItems([item], handled), []);
		assert.equal(filterHandledReviewItems([{ ...item, version: "edited" }], handled).length, 1);
	});

	it("replaces superseded records and retains only the newest bounded set", () => {
		const existing = Array.from({ length: LIMITS.reviewHandlingRecords }, (_, index) => ({
			id: `issue-comment-${index}`,
			source: "issue-comment" as const,
			version: `v${index}`,
			decision: "ignore" as const,
		}));
		const records = appendHandledReviewRecords(existing, [
			{ id: "issue-comment-500", source: "issue-comment", version: "new", decision: "dismiss" },
			{ id: "issue-comment-new", source: "issue-comment", version: "new", decision: "fix" },
		]);
		assert.equal(records.length, LIMITS.reviewHandlingRecords);
		assert.equal(
			records.some((record) => record.id === "issue-comment-0"),
			false,
		);
		assert.equal(records.filter((record) => record.id === "issue-comment-500").length, 1);
		assert.equal(records.find((record) => record.id === "issue-comment-500")?.version, "new");
	});
});

describe("pending review replies", () => {
	it("does not evict pending records at the bound", () => {
		const pending = Array.from({ length: LIMITS.reviewHandlingRecords }, (_, index) => ({
			id: `PRRT_${index}`,
			version: `v${index}`,
		}));
		const result = appendPendingReviewReply(pending, { id: "PRRT_new", version: "new" });
		assert.equal(result.ok, false);
		assert.equal(pending.length, LIMITS.reviewHandlingRecords);
	});

	it("removes legacy pending IDs only after their thread is absent from a complete observation", () => {
		const live = thread("review-thread", "v1");
		assert.deepEqual(reconcileLegacyPendingReplyIds([live.id, "PRRT_absent"], [live]), [live.id]);
	});
});
