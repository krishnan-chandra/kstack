import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clipLog,
	extractRunId,
	graphqlThreadToReviewThread,
	issueCommentToThread,
	type ParseResult,
	parseIssueComments,
	parseMergeStateStatus,
	parsePrChecksJson,
	parseReviewThreadsPage,
	pickLowestPrNumber,
} from "./github-parse.ts";

const UPDATED_AT = "2026-09-06T00:00:00Z";

function unwrap<T>(result: ParseResult<T>): T {
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

function comment(
	id: number,
	body: string,
	overrides: { updatedAt?: string; author?: string; path?: string; line?: number } = {},
) {
	return {
		id: `PRRC_${id}`,
		databaseId: id,
		body,
		updatedAt: overrides.updatedAt ?? UPDATED_AT,
		path: overrides.path ?? "a.ts",
		line: overrides.line ?? 4,
		url: `https://example.test/${id}`,
		author: { login: overrides.author ?? "reviewer" },
	};
}

function threadsEnvelope(nodes: unknown[]) {
	return {
		data: {
			repository: {
				pullRequest: {
					reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
				},
			},
		},
	};
}

describe("github parsers", () => {
	describe("pickLowestPrNumber", () => {
		it("sorts by number ascending, not list order", () => {
			assert.equal(pickLowestPrNumber(JSON.stringify([{ number: 12 }, { number: 3 }, { number: 7 }])), 3);
		});

		it("returns undefined for empty or invalid payloads", () => {
			assert.equal(pickLowestPrNumber("[]"), undefined);
			assert.equal(pickLowestPrNumber("not json"), undefined);
			assert.equal(pickLowestPrNumber("{}"), undefined);
		});
	});

	describe("parseMergeStateStatus", () => {
		it("maps known GitHub values", () => {
			assert.equal(parseMergeStateStatus("CLEAN"), "CLEAN");
			assert.equal(parseMergeStateStatus("dirty"), "DIRTY");
			assert.equal(parseMergeStateStatus("BEHIND"), "BEHIND");
			assert.equal(parseMergeStateStatus("nope"), "UNKNOWN");
		});
	});

	describe("parsePrChecksJson", () => {
		it("maps gh pr checks buckets", () => {
			const checks = parsePrChecksJson(
				JSON.stringify([
					{ name: "lint", state: "SUCCESS", bucket: "pass", link: "https://github.com/o/r/actions/runs/99" },
					{ name: "test", state: "FAILURE", bucket: "fail", link: "https://github.com/o/r/actions/runs/100" },
					{ name: "build", state: "PENDING", bucket: "pending" },
				]),
			);
			assert.equal(checks.length, 3);
			assert.equal(checks[0].conclusion, "success");
			assert.equal(checks[0].runId, "99");
			assert.equal(checks[1].conclusion, "failure");
			assert.equal(checks[1].runId, "100");
			assert.equal(checks[2].status, "pending");
			assert.equal(checks[2].conclusion, null);
		});

		it("keeps cancelled checks distinct from neutral checks", () => {
			const checks = parsePrChecksJson(
				JSON.stringify([
					{ name: "cancelled", state: "CANCELLED", bucket: "cancel" },
					{ name: "allowed-neutral", state: "NEUTRAL", bucket: "neutral" },
				]),
			);
			assert.equal(checks[0].status, "cancelled");
			assert.equal(checks[0].conclusion, "cancelled");
			assert.equal(checks[1].status, "neutral");
		});
	});

	describe("parseReviewThreadsPage", () => {
		it("uses the latest non-owned comment and keeps all non-owned evidence in its version", () => {
			const page = unwrap(
				parseReviewThreadsPage(
					threadsEnvelope([
						{
							id: "PRRT_open",
							isResolved: false,
							comments: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [
									comment(1, "first", { author: "ann" }),
									comment(2, "<!-- pr-autopilot -->\nAddressed.", { author: "kstack" }),
									comment(3, "please rename", { author: "bob" }),
								],
							},
						},
						{ id: "PRRT_done", isResolved: true, comments: { nodes: [] } },
					]),
				),
			);
			const open = graphqlThreadToReviewThread(page.threads[0]);
			const done = graphqlThreadToReviewThread(page.threads[1]);
			assert.ok(open);
			assert.equal(open.body, "please rename");
			assert.equal(open.replyToId, 3);
			assert.equal(open.commenter, "bob");
			assert.match(open.version, /^[0-9a-f]{64}$/);
			assert.equal(done, undefined);
		});

		it("changes the version when an earlier represented comment is edited", () => {
			const makeVersion = (body: string) => {
				const page = unwrap(
					parseReviewThreadsPage(
						threadsEnvelope([
							{
								id: "PRRT_1",
								isResolved: false,
								comments: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [comment(1, body), comment(2, "latest")],
								},
							},
						]),
					),
				);
				return graphqlThreadToReviewThread(page.threads[0])?.version;
			};
			assert.notEqual(makeVersion("original"), makeVersion("edited"));
		});

		it("rejects partial errors and malformed required comment fields", () => {
			const partial = parseReviewThreadsPage({ ...threadsEnvelope([]), errors: [{ message: "partial" }] });
			assert.equal(partial.ok, false);
			const missingTimestamp = parseReviewThreadsPage(
				threadsEnvelope([
					{
						id: "PRRT_1",
						isResolved: false,
						comments: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [{ ...comment(1, "body"), updatedAt: undefined }],
						},
					},
				]),
			);
			assert.equal(missingTimestamp.ok, false);
			const missingId = parseReviewThreadsPage(
				threadsEnvelope([
					{
						id: "PRRT_1",
						isResolved: false,
						comments: {
							pageInfo: { hasNextPage: false, endCursor: null },
							nodes: [{ ...comment(1, "body"), id: undefined }],
						},
					},
				]),
			);
			assert.equal(missingId.ok, false);
		});
	});

	describe("parseIssueComments", () => {
		it("maps REST issue comments with full-body freshness", () => {
			const comments = unwrap(
				parseIssueComments(
					JSON.stringify([
						{ id: 9, user: { login: "bugbot" }, body: "npe", updated_at: UPDATED_AT, html_url: "https://example/9" },
						{ id: 10, user: { login: "me" }, body: "<!-- pr-autopilot -->\nAddressed.", updated_at: UPDATED_AT },
					]),
				),
			);
			assert.equal(comments.length, 1);
			const thread = issueCommentToThread(comments[0]);
			assert.equal(thread.id, "issue-comment-9");
			assert.equal(thread.source, "issue-comment");
			assert.equal(thread.commenter, "bugbot");
			assert.match(thread.version, /^[0-9a-f]{64}$/);
		});

		it("filters Kstack navigation comments but keeps legitimate bot feedback", () => {
			const comments = unwrap(
				parseIssueComments(
					JSON.stringify([
						{
							id: 11,
							user: { login: "publisher" },
							body: "<!-- kstack-stack-nav -->\nNavigation",
							updated_at: UPDATED_AT,
						},
						{ id: 12, user: { login: "dependabot" }, body: "Please update this API.", updated_at: UPDATED_AT },
					]),
				),
			);
			assert.deepEqual(
				comments.map((item) => item.id),
				[12],
			);
		});

		it("accepts slurped pagination and keeps page order", () => {
			const comments = unwrap(
				parseIssueComments(
					JSON.stringify([
						[{ id: 1, user: { login: "first" }, body: "first page", updated_at: UPDATED_AT }],
						[{ id: 2, user: { login: "second" }, body: "second page", updated_at: UPDATED_AT }],
					]),
				),
			);
			assert.deepEqual(
				comments.map((item) => item.id),
				[1, 2],
			);
		});

		it("filters owned replies before retaining the newest bounded set", () => {
			const rows = Array.from({ length: 105 }, (_, index) => ({
				id: index + 1,
				user: { login: "reviewer" },
				body: index === 104 ? "<!-- pr-autopilot -->\nhandled" : `comment ${index + 1}`,
				updated_at: UPDATED_AT,
			}));
			const comments = unwrap(parseIssueComments(JSON.stringify(rows)));
			assert.equal(comments.length, 100);
			assert.equal(comments[0].id, 5);
			assert.equal(comments.at(-1)?.id, 104);
		});

		it("reports the correct position for an invalid issue-comment id", () => {
			const parsed = parseIssueComments(
				JSON.stringify([
					{ id: 1, user: { login: "reviewer" }, body: "first", updated_at: UPDATED_AT },
					{ id: "invalid", user: { login: "reviewer" }, body: "second", updated_at: UPDATED_AT },
				]),
			);
			assert.deepEqual(parsed, { ok: false, error: "Issue comment 2 has an invalid id." });
		});

		it("rejects missing timestamps", () => {
			assert.equal(
				parseIssueComments(JSON.stringify([{ id: 1, user: { login: "reviewer" }, body: "body" }])).ok,
				false,
			);
		});
	});

	describe("extractRunId and clipLog", () => {
		it("extracts an Actions run id", () => {
			assert.equal(extractRunId("https://github.com/o/r/actions/runs/12345"), "12345");
			assert.equal(extractRunId("https://vercel.com/log"), undefined);
		});

		it("clips from the tail", () => {
			const clipped = clipLog("abcdefghij", 4);
			assert.ok(clipped.length <= 4);
			assert.match(clipped, /hij|ghij/);
		});
	});
});
