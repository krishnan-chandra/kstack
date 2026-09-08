import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import {
	getCheckRuns,
	getIssueComments,
	getReviewThreads,
	isForbiddenStagingPath,
	replyToReviewComment,
	viewPR,
} from "./github.ts";

describe("GitHub state boundaries", () => {
	it("fails review-thread state when the explicit repository identity is malformed", async () => {
		const result = await getReviewThreads(async () => ({ code: 0, stdout: "", stderr: "" }), "/repo", 7, "bad");
		assert.deepEqual(result, {
			code: 1,
			stdout: "",
			stderr: "Invalid GitHub repository for review threads.",
			threads: [],
		});
	});

	it("pages past the first 20 comments before representing a thread", async () => {
		let graphqlReads = 0;
		const result = await getReviewThreads(
			async (_command, args) => {
				if (args[0] === "repo") return { code: 0, stdout: "owner/repo\n", stderr: "" };
				graphqlReads++;
				if (graphqlReads === 1) {
					const comments = Array.from({ length: 20 }, (_, index) => ({
						id: `PRRC_${index + 1}`,
						databaseId: index + 1,
						body: `comment ${index + 1}`,
						updatedAt: "2026-09-06T00:00:00Z",
						path: "src/a.ts",
						line: index + 1,
						url: `https://example.test/${index + 1}`,
						author: { login: "reviewer" },
					}));
					return {
						code: 0,
						stdout: JSON.stringify({
							data: {
								repository: {
									pullRequest: {
										reviewThreads: {
											pageInfo: { hasNextPage: false, endCursor: null },
											nodes: [
												{
													id: "PRRT_1",
													isResolved: false,
													comments: {
														pageInfo: { hasNextPage: true, endCursor: "comment-cursor-20" },
														nodes: comments,
													},
												},
											],
										},
									},
								},
							},
						}),
						stderr: "",
					};
				}
				return {
					code: 0,
					stdout: JSON.stringify({
						data: {
							node: {
								id: "PRRT_1",
								isResolved: false,
								comments: {
									pageInfo: { hasNextPage: false, endCursor: null },
									nodes: [
										{
											id: "PRRC_21",
											databaseId: 21,
											body: "comment 21",
											updatedAt: "2026-09-06T00:01:00Z",
											path: "src/a.ts",
											line: 21,
											url: "https://example.test/21",
											author: { login: "reviewer" },
										},
									],
								},
							},
						},
					}),
					stderr: "",
				};
			},
			"/repo",
			7,
			"owner/repo",
		);

		assert.equal(result.code, 0);
		assert.equal(result.threads[0]?.body, "comment 21");
		assert.equal(graphqlReads, 2);
	});

	it("fails closed when an outer page has no continuation cursor", async () => {
		const result = await getReviewThreads(
			async () => ({
				code: 0,
				stdout: JSON.stringify({
					data: {
						repository: {
							pullRequest: {
								reviewThreads: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
							},
						},
					},
				}),
				stderr: "",
			}),
			"/repo",
			7,
			"owner/repo",
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /no end cursor/);
	});

	it("fails closed when an outer cursor repeats", async () => {
		let reads = 0;
		const result = await getReviewThreads(
			async () => {
				reads++;
				return {
					code: 0,
					stdout: JSON.stringify({
						data: {
							repository: {
								pullRequest: {
									reviewThreads: {
										pageInfo: { hasNextPage: true, endCursor: "same-cursor" },
										nodes: [],
									},
								},
							},
						},
					}),
					stderr: "",
				};
			},
			"/repo",
			7,
			"owner/repo",
		);
		assert.equal(result.code, 1);
		assert.equal(reads, 2);
		assert.match(result.stderr, /repeated cursor/);
	});

	it("fails closed when the outer thread-page bound is exhausted", async () => {
		let reads = 0;
		const result = await getReviewThreads(
			async () => {
				reads++;
				return {
					code: 0,
					stdout: JSON.stringify({
						data: {
							repository: {
								pullRequest: {
									reviewThreads: {
										pageInfo: { hasNextPage: true, endCursor: `cursor-${reads}` },
										nodes: [],
									},
								},
							},
						},
					}),
					stderr: "",
				};
			},
			"/repo",
			7,
			"owner/repo",
		);
		assert.equal(result.code, 1);
		assert.equal(reads, 20);
		assert.match(result.stderr, /20-page limit/);
	});

	it("checks cancellation between thread pages", async () => {
		const controller = new AbortController();
		let reads = 0;
		const result = await getReviewThreads(
			async () => {
				reads++;
				controller.abort();
				return {
					code: 0,
					stdout: JSON.stringify({
						data: {
							repository: {
								pullRequest: {
									reviewThreads: {
										pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
										nodes: [],
									},
								},
							},
						},
					}),
					stderr: "",
				};
			},
			"/repo",
			7,
			"owner/repo",
			controller.signal,
		);
		assert.equal(result.code, 130);
		assert.equal(reads, 1);
	});

	it("fails closed when a thread still has data at the comment bound", async () => {
		let reads = 0;
		let nextCommentId = 1;
		const comments = (count: number) =>
			Array.from({ length: count }, () => {
				const id = nextCommentId++;
				return {
					id: `PRRC_${id}`,
					databaseId: id,
					body: `comment ${id}`,
					updatedAt: "2026-09-06T00:00:00Z",
					path: "src/a.ts",
					line: 1,
					author: { login: "reviewer" },
				};
			});
		const result = await getReviewThreads(
			async () => {
				reads++;
				const count = reads === 1 ? 20 : reads < 6 ? 100 : 80;
				const node = {
					id: "PRRT_1",
					isResolved: false,
					comments: {
						pageInfo: { hasNextPage: true, endCursor: `comment-cursor-${reads}` },
						nodes: comments(count),
					},
				};
				const data =
					reads === 1
						? {
								repository: {
									pullRequest: {
										reviewThreads: {
											pageInfo: { hasNextPage: false, endCursor: null },
											nodes: [node],
										},
									},
								},
							}
						: { node };
				return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
			},
			"/repo",
			7,
			"owner/repo",
		);
		assert.equal(result.code, 1);
		assert.equal(reads, 6);
		assert.match(result.stderr, /500-comment limit/);
	});

	it("fails closed when the fetch-wide comment bound is exceeded", async () => {
		let reads = 0;
		const pages = new Map<string, number>();
		const makeComments = (threadIndex: number, start: number, count: number) =>
			Array.from({ length: count }, (_, index) => {
				const databaseId = threadIndex * 1000 + start + index;
				return {
					id: `PRRC_${threadIndex}_${start + index}`,
					databaseId,
					body: `comment ${databaseId}`,
					updatedAt: "2026-09-06T00:00:00Z",
					path: "src/a.ts",
					line: 1,
					author: { login: "reviewer" },
				};
			});
		const result = await getReviewThreads(
			async (_command, args) => {
				reads++;
				if (reads === 1) {
					const nodes = Array.from({ length: 11 }, (_, index) => ({
						id: `PRRT_${index + 1}`,
						isResolved: false,
						comments: {
							pageInfo: { hasNextPage: true, endCursor: `cursor-${index + 1}-0` },
							nodes: makeComments(index + 1, 1, 20),
						},
					}));
					return {
						code: 0,
						stdout: JSON.stringify({
							data: {
								repository: {
									pullRequest: {
										reviewThreads: {
											pageInfo: { hasNextPage: false, endCursor: null },
											nodes,
										},
									},
								},
							},
						}),
						stderr: "",
					};
				}
				const threadId = args.find((arg) => arg.startsWith("id="))?.slice(3) ?? "";
				const threadIndex = Number(threadId.slice("PRRT_".length));
				const page = (pages.get(threadId) ?? 0) + 1;
				pages.set(threadId, page);
				const count = page < 5 ? 100 : 80;
				const start = 21 + (page - 1) * 100;
				return {
					code: 0,
					stdout: JSON.stringify({
						data: {
							node: {
								id: threadId,
								isResolved: false,
								comments: {
									pageInfo: {
										hasNextPage: page < 5,
										endCursor: page < 5 ? `cursor-${threadIndex}-${page}` : null,
									},
									nodes: makeComments(threadIndex, start, count),
								},
							},
						},
					}),
					stderr: "",
				};
			},
			"/repo",
			7,
			"owner/repo",
		);
		assert.equal(result.code, 1);
		assert.equal(reads, 51);
		assert.match(result.stderr, /limits were exceeded/);
	});
});

describe("explicit repository API paths", () => {
	it("does not rely on checkout placeholders for issue comments", async () => {
		let capturedArgs: string[] = [];
		const result = await getIssueComments(
			async (_command, args) => {
				capturedArgs = args;
				return { code: 0, stdout: "[]", stderr: "" };
			},
			"/secondary-jj-workspace",
			42,
			"owner/repo",
		);
		assert.equal(result.code, 0);
		assert.equal(capturedArgs[1], "repos/owner/repo/issues/42/comments");
	});

	it("rejects a malformed explicit repository for issue comments", async () => {
		const result = await getIssueComments(
			async () => ({ code: 0, stdout: "[]", stderr: "" }),
			"/secondary-jj-workspace",
			42,
			"bad",
		);
		assert.deepEqual(result, {
			code: 1,
			stdout: "",
			stderr: "Invalid GitHub repository for issue comments.",
			threads: [],
		});
	});

	it("does not rely on checkout placeholders when replying to review comments", async () => {
		let capturedArgs: string[] = [];
		await replyToReviewComment(
			async (_command, args) => {
				capturedArgs = args;
				return { code: 0, stdout: "{}", stderr: "" };
			},
			"/secondary-jj-workspace",
			42,
			7,
			"Addressed.",
			"owner/repo",
		);
		assert.equal(capturedArgs[1], "repos/owner/repo/pulls/42/comments");
	});
});

describe("porcelain and forbidden paths", () => {
	it("enumerates changed paths losslessly from git status --porcelain=v1 -z", async () => {
		const nul = "\0";
		// NUL-delimited porcelain v1 format:
		//   Ordinary: "XY<space>path\0"
		//   Rename:   "XY<space>destination\0source\0" (destination first)
		const output = [
			" M src/a.ts", // 1. modified tracked file
			"?? new.ts", // 2. untracked ordinary file
			"?? file with spaces.ts", // 3. filename with spaces — no quoting
			"?? file\nwith\nnewlines.ts", // 4. filename with embedded newlines
			"R  dest.ts", // 5. rename: destination
			"source.ts", // 5. rename: source (next NUL field)
			"?? utils/untracked/nested.ts", // 6. nested untracked file
			"?? .github/workflows/ci.yml", // 7. workflow file under untracked dir
			"?? secrets/credentials.json", // 8. credential-like path
			"?? .env.local", // 9. env file
			"", // trailing NUL — ignored
		].join(nul);

		let capturedArgs: string[] | undefined;
		const backend = new GitBackend(async (_cmd, args, _opts) => {
			capturedArgs = args;
			return { code: 0, stdout: output, stderr: "" };
		});

		const result = await backend.changedPaths("/repo");
		assert.ok(result.ok);

		// Must use the correct Git invocation
		assert.deepEqual(capturedArgs, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

		assert.deepEqual(result.paths, [
			"src/a.ts",
			"new.ts",
			"file with spaces.ts",
			"file\nwith\nnewlines.ts",
			"dest.ts",
			"source.ts",
			"utils/untracked/nested.ts",
			".github/workflows/ci.yml",
			"secrets/credentials.json",
			".env.local",
		]);
	});

	it("returns failed result when git status fails", async () => {
		const backend = new GitBackend(async () => ({
			code: 128,
			stdout: "",
			stderr: "fatal: not a git repository",
		}));
		const result = await backend.changedPaths("/not-a-repo");
		assert.ok(!result.ok);
		assert.equal(result.error, "Could not inspect working-copy changes: fatal: not a git repository");
	});

	it("forbidden-path bridge: isForbiddenStagingPath blocks exact paths from changedPaths", () => {
		// The parser returns exact full paths; the autopilot predicate must
		// block the same strings that changedPaths() now returns losslessly.
		assert.equal(isForbiddenStagingPath(".github/workflows/ci.yml"), true);
		assert.equal(isForbiddenStagingPath("secrets/credentials.json"), true);
		assert.equal(isForbiddenStagingPath(".env.local"), true);
		assert.equal(isForbiddenStagingPath(".env"), true);
		assert.equal(isForbiddenStagingPath("apps/web/.env.local"), true);
		// Safe paths are not blocked
		assert.equal(isForbiddenStagingPath("src/a.ts"), false);
		assert.equal(isForbiddenStagingPath("new.ts"), false);
		assert.equal(isForbiddenStagingPath("utils/untracked/nested.ts"), false);
	});
});

describe("viewPR", () => {
	it("includes statusCheckRollup in the requested fields", async () => {
		let capturedArgs: string[] = [];
		const result = await viewPR(
			async (_command, args) => {
				capturedArgs = args;
				return {
					code: 0,
					stdout: JSON.stringify({
						number: 42,
						headRefOid: "abc",
						statusCheckRollup: [],
					}),
					stderr: "",
				};
			},
			"/repo",
			42,
		);

		assert.equal(result.code, 0);
		assert.ok(result.pr);
		assert.deepEqual(result.pr.statusCheckRollup, { kind: "empty" });
		const jsonIndex = capturedArgs.indexOf("--json");
		assert.ok(jsonIndex >= 0);
		const fields = capturedArgs[jsonIndex + 1]?.split(",") ?? [];
		assert.ok(fields.includes("statusCheckRollup"));
	});

	it("fails closed on authentication or CLI error", async () => {
		const result = await viewPR(async () => ({ code: 1, stdout: "", stderr: "authentication required" }), "/repo", 42);
		assert.equal(result.code, 1);
		assert.equal(result.pr, undefined);
		assert.equal(result.stderr, "authentication required");
	});

	it("parses nonempty statusCheckRollup array", async () => {
		const result = await viewPR(
			async () => ({
				code: 0,
				stdout: JSON.stringify({
					number: 42,
					headRefOid: "abc",
					statusCheckRollup: [{ __typename: "CheckRun" }],
				}),
				stderr: "",
			}),
			"/repo",
			42,
		);
		assert.equal(result.code, 0);
		assert.ok(result.pr);
		assert.deepEqual(result.pr.statusCheckRollup, { kind: "present" });
	});
});

describe("getCheckRuns", () => {
	it("distinguishes the CLI's no-checks response from other failures", async () => {
		const noChecks = await getCheckRuns(
			async () => ({
				code: 1,
				stdout: "",
				stderr: "no checks reported on the 'kstack/fix-thing' branch\n",
			}),
			"/repo",
			42,
		);
		assert.deepEqual(noChecks, { kind: "no-checks" });

		const authFailure = await getCheckRuns(
			async () => ({ code: 1, stdout: "", stderr: "authentication required" }),
			"/repo",
			42,
		);
		assert.deepEqual(authFailure, { kind: "error", message: "authentication required" });
	});

	it("returns failure when CLI exits 0 with malformed JSON, empty stdout, or non-array", async () => {
		const emptyResult = await getCheckRuns(async () => ({ code: 0, stdout: "", stderr: "" }), "/repo", 42);
		assert.deepEqual(emptyResult, { kind: "error", message: "Could not parse checks: Checks output is empty." });

		const malformedResult = await getCheckRuns(
			async () => ({ code: 0, stdout: "invalid json", stderr: "" }),
			"/repo",
			42,
		);
		assert.deepEqual(malformedResult, {
			kind: "error",
			message: "Could not parse checks: Checks output is not valid JSON.",
		});

		const nonArrayResult = await getCheckRuns(async () => ({ code: 0, stdout: "{}", stderr: "" }), "/repo", 42);
		assert.deepEqual(nonArrayResult, {
			kind: "error",
			message: "Could not parse checks: Checks output is not an array.",
		});
	});

	it("parses valid check runs on exit 0", async () => {
		const result = await getCheckRuns(
			async () => ({
				code: 0,
				stdout: JSON.stringify([
					{ name: "lint", state: "SUCCESS", bucket: "pass" },
					{ name: "test", state: "FAILURE", bucket: "fail", link: "https://github.com/o/r/actions/runs/123" },
				]),
				stderr: "",
			}),
			"/repo",
			42,
		);
		assert.equal(result.kind, "checks");
		if (result.kind !== "checks") return;
		assert.equal(result.checks.length, 2);
		assert.equal(result.checks[0].name, "lint");
		assert.equal(result.checks[0].conclusion, "success");
		assert.equal(result.checks[1].name, "test");
		assert.equal(result.checks[1].conclusion, "failure");
		assert.equal(result.checks[1].runId, "123");
	});
});
