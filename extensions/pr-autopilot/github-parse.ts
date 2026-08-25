import { type BoundaryValue, isBoolean, isNumber, isString } from "../shared/validation.ts";
/**
 * Pure parsing and formatting of GitHub CLI output.
 *
 * These helpers never run `gh` or `git`. Execution wrappers live in `github.ts`.
 */

import { KSTACK_COMMENT_MARKER } from "../shared/github.ts";
import { isRecord } from "../shared/narrow.ts";
import type { CheckRun, MergeStateStatus, ReviewThread } from "./types.ts";
import { LIMITS } from "./types.ts";

const AUTOPILOT_REPLY_MARKER = "<!-- pr-autopilot -->";

function autopilotReplyBody(body: string): string {
	if (body.includes(AUTOPILOT_REPLY_MARKER)) return body;
	return `${AUTOPILOT_REPLY_MARKER}\n${body}`;
}

function isAutomationComment(body: string): boolean {
	return body.includes(AUTOPILOT_REPLY_MARKER) || body.includes(KSTACK_COMMENT_MARKER);
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
	};
}

interface GraphqlComment {
	databaseId?: number;
	body: string;
	path?: string;
	line?: number;
	url?: string;
	authorLogin: string;
}

interface GraphqlThread {
	id: string;
	isResolved: boolean;
	comments: GraphqlComment[];
}

export interface GraphqlPage {
	threads: GraphqlThread[];
	hasNextPage: boolean;
	endCursor?: string;
}

function parseGraphqlComment(raw: BoundaryValue): GraphqlComment | undefined {
	if (!isRecord(raw)) return undefined;
	const body = isString(raw.body) ? raw.body : "";
	const author = isRecord(raw.author) ? asString(raw.author.login) : undefined;
	const databaseId = asNumber(raw.databaseId);
	return {
		databaseId: databaseId !== undefined && Number.isInteger(databaseId) ? databaseId : undefined,
		body,
		path: asString(raw.path),
		line: asNumber(raw.line),
		url: asString(raw.url),
		authorLogin: author ?? "unknown",
	};
}

/** Parse one page of the reviewThreads GraphQL response. */
export function parseReviewThreadsPage(raw: BoundaryValue): GraphqlPage {
	if (!isRecord(raw)) return { threads: [], hasNextPage: false };
	const data = isRecord(raw.data) ? raw.data : raw;
	const repository = isRecord(data.repository) ? data.repository : undefined;
	const pullRequest = repository && isRecord(repository.pullRequest) ? repository.pullRequest : undefined;
	const reviewThreads = pullRequest && isRecord(pullRequest.reviewThreads) ? pullRequest.reviewThreads : undefined;
	if (!reviewThreads) return { threads: [], hasNextPage: false };
	const pageInfo = isRecord(reviewThreads.pageInfo) ? reviewThreads.pageInfo : undefined;
	const nodes = Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : [];
	const threads: GraphqlThread[] = [];
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		const id = asString(node.id);
		if (!id) continue;
		const commentsRaw = isRecord(node.comments) && Array.isArray(node.comments.nodes) ? node.comments.nodes : [];
		const comments = commentsRaw.flatMap((c) => {
			const parsed = parseGraphqlComment(c);
			return parsed ? [parsed] : [];
		});
		threads.push({
			id,
			isResolved: asBoolean(node.isResolved) === true,
			comments,
		});
	}
	return {
		threads,
		hasNextPage: asBoolean(pageInfo?.hasNextPage) === true,
		endCursor: asString(pageInfo?.endCursor),
	};
}

export function graphqlThreadToReviewThread(thread: GraphqlThread): ReviewThread | undefined {
	if (thread.isResolved || thread.comments.length === 0) return undefined;
	const first = thread.comments[0];
	const last = thread.comments[thread.comments.length - 1];
	return {
		id: thread.id,
		commenter: last.authorLogin || first.authorLogin,
		body: last.body || first.body,
		path: first.path ?? last.path,
		line: first.line ?? last.line,
		url: last.url ?? first.url,
		replyToId: last.databaseId ?? first.databaseId,
		source: "review-thread",
	};
}

interface RawIssueComment {
	id: number;
	commenter: string;
	body: string;
	url?: string;
}

export function parseIssueComments(stdout: string): RawIssueComment[] {
	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const items: BoundaryValue[] = parsed.every(Array.isArray) ? parsed.flat() : parsed;
	const comments: RawIssueComment[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const id = asNumber(item.id);
		if (id === undefined || !Number.isInteger(id) || id < 1) continue;
		const user = isRecord(item.user) ? asString(item.user.login) : asString(item.commenter);
		const body = isString(item.body) ? item.body : "";
		if (isAutomationComment(body)) continue;
		comments.push({
			id,
			commenter: user ?? "unknown",
			body,
			url: asString(item.html_url) ?? asString(item.url),
		});
	}
	return comments.slice(-LIMITS.issueComments);
}

export function issueCommentToThread(comment: RawIssueComment): ReviewThread {
	return {
		id: `issue-comment-${comment.id}`,
		commenter: comment.commenter,
		body: comment.body,
		url: comment.url,
		replyToId: comment.id,
		source: "issue-comment",
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

export function parsePrChecksJson(stdout: string): CheckRun[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const checks: CheckRun[] = [];
	for (const row of rows) {
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
	return checks;
}

export { autopilotReplyBody, parseGHPr, splitRepo };
