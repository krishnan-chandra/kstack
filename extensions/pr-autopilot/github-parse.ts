import { type BoundaryValue, isBoolean, isNumber, isString } from "../shared/validation.ts";

/**
 * Pure parsing and formatting of GitHub CLI output.
 *
 * These helpers never run `gh` or `git`. Execution wrappers live in `github.ts`.
 */

import { isRecord } from "../shared/narrow.ts";
import { AUTOPILOT_REPLY_MARKER, isOwnedReviewComment, versionReviewItem } from "./review-handling.ts";
import type { CheckRun, MergeStateStatus, ReviewCommentEvidence, ReviewThread } from "./types.ts";
import { LIMITS } from "./types.ts";

function autopilotReplyBody(body: string): string {
	if (body.includes(AUTOPILOT_REPLY_MARKER)) return body;
	return `${AUTOPILOT_REPLY_MARKER}\n${body}`;
}

function asString(value: BoundaryValue): string | undefined {
	return isString(value) && value.length > 0 ? value : undefined;
}

function asNumber(value: BoundaryValue): number | undefined {
	return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: BoundaryValue): boolean | undefined {
	return isBoolean(value) ? value : undefined;
}

function isTimestamp(value: string | undefined): value is string {
	return value !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function splitRepo(repo: string): { owner: string; name: string } | undefined {
	const slash = repo.indexOf("/");
	if (slash <= 0 || slash === repo.length - 1) return undefined;
	return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/** Parse `gh pr list --json number` and return the lowest number. */
export function pickLowestPrNumber(stdout: string): number | undefined {
	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const numbers: number[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) continue;
		const n = asNumber(item.number);
		if (n !== undefined && Number.isInteger(n) && n >= 1) numbers.push(n);
	}
	if (numbers.length === 0) return undefined;
	numbers.sort((a, b) => a - b);
	return numbers[0];
}

export function parseMergeStateStatus(raw: BoundaryValue): MergeStateStatus {
	if (!isString(raw)) return "UNKNOWN";
	switch (raw.toUpperCase()) {
		case "CLEAN":
			return "CLEAN";
		case "DIRTY":
			return "DIRTY";
		case "BEHIND":
			return "BEHIND";
		case "BLOCKED":
			return "BLOCKED";
		case "DRAFT":
			return "DRAFT";
		case "UNSTABLE":
			return "UNSTABLE";
		case "HAS_HOOKS":
			return "HAS_HOOKS";
		case "UNKNOWN":
			return "UNKNOWN";
		default:
			return "UNKNOWN";
	}
}

type StatusCheckRollupSummary = { kind: "empty" } | { kind: "present" };

export interface GHPrJson {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	mergeable: string;
	mergeStateStatus: MergeStateStatus;
	headRefName: string;
	baseRefName: string;
	headSha: string;
	commits?: Array<{ oid: string }>;
	statusCheckRollup?: StatusCheckRollupSummary;
}

function parseStatusCheckRollup(raw: BoundaryValue): StatusCheckRollupSummary | undefined {
	if (!Array.isArray(raw)) return undefined;
	return raw.length === 0 ? { kind: "empty" } : { kind: "present" };
}

function parseGHPr(raw: BoundaryValue): GHPrJson | undefined {
	if (!isRecord(raw)) return undefined;
	const number = asNumber(raw.number);
	if (number === undefined || number < 1) return undefined;
	const headSha = asString(raw.headRefOid) ?? asString(raw.headSha) ?? "";
	return {
		number,
		title: asString(raw.title) ?? "",
		state: asString(raw.state) ?? "open",
		isDraft: asBoolean(raw.isDraft) ?? false,
		mergeable: asString(raw.mergeable) ?? "unknown",
		mergeStateStatus: parseMergeStateStatus(raw.mergeStateStatus),
		headRefName: asString(raw.headRefName) ?? "",
		baseRefName: asString(raw.baseRefName) ?? "",
		headSha,
		commits: Array.isArray(raw.commits)
			? raw.commits.flatMap((c) => {
					if (!isRecord(c)) return [];
					const oid = asString(c.oid);
					return oid ? [{ oid }] : [];
				})
			: [],
		statusCheckRollup: parseStatusCheckRollup(raw.statusCheckRollup),
	};
}

interface GraphqlComment extends ReviewCommentEvidence {
	databaseId: number;
	url?: string;
}

interface GraphqlCommentPage {
	comments: GraphqlComment[];
	hasNextPage: boolean;
	endCursor?: string;
}

export type GraphqlThread =
	| { id: string; isResolved: true }
	| { id: string; isResolved: false; commentPage: GraphqlCommentPage };

export interface GraphqlPage {
	threads: GraphqlThread[];
	hasNextPage: boolean;
	endCursor?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parsePageInfo(raw: BoundaryValue, label: string): ParseResult<{ hasNextPage: boolean; endCursor?: string }> {
	if (!isRecord(raw) || !isBoolean(raw.hasNextPage)) return { ok: false, error: `${label} pageInfo is malformed.` };
	const endCursor = asString(raw.endCursor);
	if (raw.hasNextPage && !endCursor) return { ok: false, error: `${label} has another page but no end cursor.` };
	return { ok: true, value: { hasNextPage: raw.hasNextPage, endCursor } };
}

function parseGraphqlComment(raw: BoundaryValue, label: string): ParseResult<GraphqlComment> {
	if (!isRecord(raw)) return { ok: false, error: `${label} is not an object.` };
	const id = asString(raw.id);
	const databaseId = asNumber(raw.databaseId);
	const updatedAt = asString(raw.updatedAt);
	if (!id) return { ok: false, error: `${label} has no stable id.` };
	if (databaseId === undefined || !Number.isSafeInteger(databaseId) || databaseId < 1) {
		return { ok: false, error: `${label} has an invalid databaseId.` };
	}
	if (!isString(raw.body)) return { ok: false, error: `${label} has no body.` };
	if (!isTimestamp(updatedAt)) {
		return { ok: false, error: `${label} has an invalid updatedAt timestamp.` };
	}
	let author: string | null = null;
	if (raw.author !== null && raw.author !== undefined) {
		if (!isRecord(raw.author)) return { ok: false, error: `${label} has a malformed author.` };
		author = asString(raw.author.login) ?? null;
		if (author === null) return { ok: false, error: `${label} has a malformed author login.` };
	}
	const line = raw.line === null || raw.line === undefined ? undefined : asNumber(raw.line);
	if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
		return { ok: false, error: `${label} has an invalid line.` };
	}
	const path = raw.path === null || raw.path === undefined ? undefined : asString(raw.path);
	if (raw.path !== null && raw.path !== undefined && path === undefined) {
		return { ok: false, error: `${label} has an invalid path.` };
	}
	return {
		ok: true,
		value: {
			id,
			databaseId,
			body: raw.body,
			updatedAt,
			author,
			path,
			line,
			url: asString(raw.url),
		},
	};
}

function parseCommentConnection(raw: BoundaryValue, label: string): ParseResult<GraphqlCommentPage> {
	if (!isRecord(raw) || !Array.isArray(raw.nodes)) {
		return { ok: false, error: `${label} comment connection is malformed.` };
	}
	const pageInfo = parsePageInfo(raw.pageInfo, `${label} comments`);
	if (!pageInfo.ok) return pageInfo;
	const comments: GraphqlComment[] = [];
	for (const [index, node] of raw.nodes.entries()) {
		const comment = parseGraphqlComment(node, `${label} comment ${index + 1}`);
		if (!comment.ok) return comment;
		comments.push(comment.value);
	}
	return { ok: true, value: { comments, ...pageInfo.value } };
}

function parseGraphqlThread(raw: BoundaryValue, label: string): ParseResult<GraphqlThread> {
	if (!isRecord(raw)) return { ok: false, error: `${label} is not an object.` };
	const id = asString(raw.id);
	const isResolved = asBoolean(raw.isResolved);
	if (!id) return { ok: false, error: `${label} has no id.` };
	if (isResolved === undefined) return { ok: false, error: `${label} has no resolution state.` };
	if (isResolved) return { ok: true, value: { id, isResolved } };
	const commentPage = parseCommentConnection(raw.comments, label);
	if (!commentPage.ok) return commentPage;
	return { ok: true, value: { id, isResolved, commentPage: commentPage.value } };
}

function parseGraphqlData(raw: BoundaryValue): ParseResult<Record<string, BoundaryValue>> {
	if (!isRecord(raw)) return { ok: false, error: "GraphQL response is not an object." };
	if (raw.errors !== undefined && (!Array.isArray(raw.errors) || raw.errors.length > 0)) {
		return { ok: false, error: "GraphQL response contains partial errors." };
	}
	if (!isRecord(raw.data)) return { ok: false, error: "GraphQL response has no data object." };
	return { ok: true, value: raw.data };
}

/** Parse one page of the outer reviewThreads connection. */
export function parseReviewThreadsPage(raw: BoundaryValue): ParseResult<GraphqlPage> {
	const parsedData = parseGraphqlData(raw);
	if (!parsedData.ok) return parsedData;
	const repository = isRecord(parsedData.value.repository) ? parsedData.value.repository : undefined;
	const pullRequest = repository && isRecord(repository.pullRequest) ? repository.pullRequest : undefined;
	const reviewThreads = pullRequest && isRecord(pullRequest.reviewThreads) ? pullRequest.reviewThreads : undefined;
	if (!reviewThreads || !Array.isArray(reviewThreads.nodes)) {
		return { ok: false, error: "GraphQL reviewThreads connection is malformed." };
	}
	const pageInfo = parsePageInfo(reviewThreads.pageInfo, "Review threads");
	if (!pageInfo.ok) return pageInfo;
	const threads: GraphqlThread[] = [];
	for (const [index, node] of reviewThreads.nodes.entries()) {
		const thread = parseGraphqlThread(node, `Review thread ${index + 1}`);
		if (!thread.ok) return thread;
		threads.push(thread.value);
	}
	return { ok: true, value: { threads, ...pageInfo.value } };
}

/** Parse one node lookup used for comment pagination and pre-resolution inspection. */
export function parseReviewThreadPage(raw: BoundaryValue): ParseResult<GraphqlThread | undefined> {
	const parsedData = parseGraphqlData(raw);
	if (!parsedData.ok) return parsedData;
	if (parsedData.value.node === null) return { ok: true, value: undefined };
	const thread = parseGraphqlThread(parsedData.value.node, "Review thread");
	return thread.ok ? { ok: true, value: thread.value } : thread;
}

export function graphqlThreadToReviewThread(thread: GraphqlThread): ReviewThread | undefined {
	if (thread.isResolved) return undefined;
	const represented = thread.commentPage.comments.filter((comment) => !isOwnedReviewComment(comment.body));
	if (represented.length === 0) return undefined;
	const first = represented[0];
	const last = represented[represented.length - 1];
	return {
		id: thread.id,
		commenter: last.author ?? "unknown",
		body: last.body,
		path: last.path ?? first.path,
		line: last.line ?? first.line,
		url: last.url ?? first.url,
		replyToId: last.databaseId,
		source: "review-thread",
		version: versionReviewItem("review-thread", thread.id, represented),
	};
}

interface RawIssueComment {
	id: number;
	commenter: string;
	body: string;
	updatedAt: string;
	url?: string;
}

export function parseIssueComments(stdout: string): ParseResult<RawIssueComment[]> {
	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { ok: false, error: "Issue comments are not valid JSON." };
	}
	if (!Array.isArray(parsed)) return { ok: false, error: "Issue comments response is not an array." };
	const pages: BoundaryValue[][] = parsed.every(Array.isArray) ? parsed : [parsed];
	const comments: RawIssueComment[] = [];
	let index = 0;
	for (const page of pages) {
		for (const item of page) {
			index++;
			if (!isRecord(item)) return { ok: false, error: `Issue comment ${index} is not an object.` };
			const id = asNumber(item.id);
			if (id === undefined || !Number.isSafeInteger(id) || id < 1) {
				return { ok: false, error: `Issue comment ${index} has an invalid id.` };
			}
			if (!isString(item.body)) return { ok: false, error: `Issue comment ${id} has no body.` };
			const updatedAt = asString(item.updated_at) ?? asString(item.updatedAt);
			if (!isTimestamp(updatedAt)) {
				return { ok: false, error: `Issue comment ${id} has an invalid updated_at timestamp.` };
			}
			let commenter = "unknown";
			if (item.user !== null && item.user !== undefined) {
				if (!isRecord(item.user)) return { ok: false, error: `Issue comment ${id} has a malformed user.` };
				commenter = asString(item.user.login) ?? "unknown";
			} else {
				commenter = asString(item.commenter) ?? "unknown";
			}
			if (isOwnedReviewComment(item.body)) continue;
			comments.push({
				id,
				commenter,
				body: item.body,
				updatedAt,
				url: asString(item.html_url) ?? asString(item.url),
			});
			if (comments.length > LIMITS.issueComments) comments.shift();
		}
	}
	return { ok: true, value: comments };
}

export function issueCommentToThread(comment: RawIssueComment): ReviewThread {
	const id = `issue-comment-${comment.id}`;
	return {
		id,
		commenter: comment.commenter,
		body: comment.body,
		url: comment.url,
		replyToId: comment.id,
		source: "issue-comment",
		version: versionReviewItem("issue-comment", id, [
			{
				id: String(comment.id),
				body: comment.body,
				updatedAt: comment.updatedAt,
				author: comment.commenter,
			},
		]),
	};
}

/** Extract a GitHub Actions run id from a check details URL. */
export function extractRunId(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const match = url.match(/\/actions\/runs\/(\d+)/);
	return match ? match[1] : undefined;
}

export function clipLog(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let out = buf.subarray(buf.length - maxBytes).toString("utf8");
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(1);
	return out;
}

function parseCheckState(state: string | undefined, bucket: string | undefined): CheckRun["status"] {
	const token = (bucket ?? state ?? "pending").toLowerCase();
	if (token === "pass" || token === "success") return "success";
	if (token === "fail" || token === "failure" || token === "error") return "failure";
	if (token === "skipping" || token === "skipped") return "skipped";
	if (token === "cancel" || token === "cancelled") return "cancelled";
	if (token === "neutral") return "neutral";
	return "pending";
}

export function parsePrChecksJson(stdout: string): ParseResult<CheckRun[]> {
	const trimmed = stdout.trim();
	if (!trimmed) return { ok: false, error: "Checks output is empty." };
	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, error: "Checks output is not valid JSON." };
	}
	if (!Array.isArray(parsed)) {
		return { ok: false, error: "Checks output is not an array." };
	}
	const checks: CheckRun[] = [];
	for (const row of parsed) {
		if (!isRecord(row)) continue;
		const name = asString(row.name) ?? asString(row.workflow) ?? "unknown";
		const status = parseCheckState(asString(row.state), asString(row.bucket));
		const detailsUrl = asString(row.link) ?? asString(row.detailsUrl);
		checks.push({
			name,
			status,
			conclusion: status === "pending" ? null : status,
			detailsUrl,
			runId: extractRunId(detailsUrl),
		});
	}
	return { ok: true, value: checks };
}

export { autopilotReplyBody, parseGHPr, splitRepo };
