import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clipLog,
	extractRunId,
	graphqlThreadToReviewThread,
	issueCommentToThread,
	parseIssueComments,
	parseMergeStateStatus,
	parsePrChecksJson,
	parseReviewThreadsPage,
	pickLowestPrNumber,
} from "./github-parse.ts";

describe("github parsers", () => {
	describe("pickLowestPrNumber", () => {
		it("sorts by number ascending, not list order", () => {
			const stdout = JSON.stringify([{ number: 12 }, { number: 3 }, { number: 7 }]);
			assert.equal(pickLowestPrNumber(stdout), 3);
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
		it("keeps only unresolved threads and uses the latest comment body", () => {
			const page = parseReviewThreadsPage({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								pageInfo: { hasNextPage: false, endCursor: null },
								nodes: [
									{
										id: "PRRT_open",
										isResolved: false,
										comments: {
											nodes: [
												{ databaseId: 1, body: "first", path: "a.ts", line: 4, author: { login: "ann" } },
												{ databaseId: 2, body: "please rename", path: "a.ts", line: 4, author: { login: "bob" } },
											],
										},
									},
									{
										id: "PRRT_done",
										isResolved: true,
										comments: { nodes: [{ databaseId: 3, body: "old", author: { login: "ann" } }] },
									},
								],
							},
						},
					},
				},
			});
			assert.equal(page.threads.length, 2);
			const open = graphqlThreadToReviewThread(page.threads[0]);
			const done = graphqlThreadToReviewThread(page.threads[1]);
			assert.ok(open);
			assert.equal(open.body, "please rename");
			assert.equal(open.replyToId, 2);
			assert.equal(open.path, "a.ts");
			assert.equal(done, undefined);
		});
	});

	describe("parseIssueComments", () => {
		it("maps REST issue comments", () => {
			const comments = parseIssueComments(
				JSON.stringify([
					{ id: 9, user: { login: "bugbot" }, body: "npe", html_url: "https://example/9" },
					{ id: 10, user: { login: "me" }, body: "<!-- pr-autopilot -->\nAddressed." },
				]),
			);
			assert.equal(comments.length, 1);
			const thread = issueCommentToThread(comments[0]);
			assert.equal(thread.id, "issue-comment-9");
			assert.equal(thread.source, "issue-comment");
			assert.equal(thread.commenter, "bugbot");
		});

		it("accepts slurped pagination and keeps page order", () => {
			const comments = parseIssueComments(
				JSON.stringify([
					[{ id: 1, user: { login: "first" }, body: "first page" }],
					[{ id: 2, user: { login: "second" }, body: "second page" }],
				]),
			);
			assert.deepEqual(
				comments.map((comment) => comment.id),
				[1, 2],
			);
		});

		it("filters autopilot replies before retaining the newest bounded set", () => {
			const rows = Array.from({ length: 105 }, (_, index) => ({
				id: index + 1,
				user: { login: "reviewer" },
				body: index === 104 ? "<!-- pr-autopilot -->\nhandled" : `comment ${index + 1}`,
			}));
			const comments = parseIssueComments(JSON.stringify(rows));
			assert.equal(comments.length, 100);
			assert.equal(comments[0].id, 5);
			assert.equal(comments.at(-1)?.id, 104);
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
