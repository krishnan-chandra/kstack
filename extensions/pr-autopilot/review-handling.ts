import { createHash } from "node:crypto";
import { KSTACK_COMMENT_MARKER } from "../shared/stack/topology.ts";
import {
	type HandledReviewRecord,
	LIMITS,
	type PendingReviewReply,
	type ReviewCommentEvidence,
	type ReviewThread,
	type ThreadSource,
} from "./types.ts";

export const AUTOPILOT_REPLY_MARKER = "<!-- pr-autopilot -->";

/** Kstack ownership is explicit in the body; author identity alone never establishes ownership. */
export function isOwnedReviewComment(body: string): boolean {
	return body.includes(AUTOPILOT_REPLY_MARKER) || body.includes(KSTACK_COMMENT_MARKER);
}

/** Hash complete evidence in caller-provided order before any model-facing clipping. */
export function versionReviewItem(
	source: ThreadSource,
	id: string,
	comments: readonly ReviewCommentEvidence[],
): string {
	const serialized = JSON.stringify([
		"pr-autopilot-review-v1",
		source,
		id,
		comments.map((comment) => [
			comment.id,
			comment.body,
			comment.updatedAt,
			comment.author,
			comment.path ?? null,
			comment.line ?? null,
		]),
	]);
	return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Ignore records suppress only the exact observed version. An unresolved review
 * thread previously fixed or dismissed remains actionable regardless of its record.
 */
export function filterHandledReviewItems(
	threads: readonly ReviewThread[],
	handled: readonly HandledReviewRecord[],
): ReviewThread[] {
	const latestReviewThreads = new Map<string, HandledReviewRecord>();
	const latestIssueComments = new Map<string, HandledReviewRecord>();
	for (const record of handled) {
		const records = record.source === "review-thread" ? latestReviewThreads : latestIssueComments;
		records.set(record.id, record);
	}
	return threads.filter((thread) => {
		const records = thread.source === "review-thread" ? latestReviewThreads : latestIssueComments;
		const record = records.get(thread.id);
		if (!record || record.version !== thread.version) return true;
		if (thread.source === "review-thread") return record.decision !== "ignore";
		return false;
	});
}

/** Replace superseded versions, append new completions, then prune the oldest completed records. */
export function appendHandledReviewRecords(
	existing: readonly HandledReviewRecord[],
	additions: readonly HandledReviewRecord[],
): HandledReviewRecord[] {
	let records = [...existing];
	for (const addition of additions) {
		records = records.filter((record) => record.id !== addition.id || record.source !== addition.source);
		records.push(addition);
	}
	return records.slice(-LIMITS.reviewHandlingRecords);
}

export function hasPendingReviewReply(pending: readonly PendingReviewReply[], id: string, version: string): boolean {
	return pending.some((record) => record.id === id && record.version === version);
}

export function appendPendingReviewReply(
	pending: readonly PendingReviewReply[],
	record: PendingReviewReply,
): { ok: true; records: PendingReviewReply[] } | { ok: false; error: string } {
	if (hasPendingReviewReply(pending, record.id, record.version)) return { ok: true, records: [...pending] };
	if (pending.length >= LIMITS.reviewHandlingRecords) {
		return {
			ok: false,
			error: `Pending review replies reached the ${LIMITS.reviewHandlingRecords}-record limit; reconcile remote threads before continuing.`,
		};
	}
	return { ok: true, records: [...pending, record] };
}

export function removePendingReviewReplies(pending: readonly PendingReviewReply[], id: string): PendingReviewReply[] {
	return pending.filter((record) => record.id !== id);
}

export function reconcileLegacyPendingReplyIds(
	legacyIds: readonly string[],
	unresolvedThreads: readonly ReviewThread[],
): string[] {
	const liveIds = new Set(
		unresolvedThreads.flatMap((thread) => (thread.source === "review-thread" ? [thread.id] : [])),
	);
	return legacyIds.filter((id) => liveIds.has(id));
}
