import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { MAX_OPEN_PRS, queryOpenPullRequests } from "./pull-requests.ts";

const sha = "a".repeat(40);
const validPullRequest = {
	number: 12,
	url: "https://example.test/pull/12",
	headRefName: "kstack/top",
	baseRefName: "main",
	headRefOid: sha,
	isDraft: true,
};

function fakeExec(result: ExecFnResult, calls: string[][] = []): ExecFn {
	return async (command, args) => {
		assert.equal(command, "gh");
		calls.push(args);
		return result;
	};
}

function query(exec: ExecFn) {
	return queryOpenPullRequests({ exec, cwd: "/repo", filter: ["--head", "kstack/top"], limit: 2 });
}

describe("Graphite open pull-request queries", () => {
	it("strictly maps valid GitHub rows", async () => {
		const second = {
			...validPullRequest,
			number: 13,
			url: "https://example.test/pull/13",
			headRefName: "kstack/next",
			baseRefName: "kstack/top",
			isDraft: false,
		};
		const result = await query(fakeExec({ code: 0, stdout: JSON.stringify([validPullRequest, second]), stderr: "" }));
		assert.deepEqual(result, {
			ok: true,
			pullRequests: [
				{
					number: 12,
					url: "https://example.test/pull/12",
					ref: "kstack/top",
					baseRef: "main",
					headSha: sha,
					draft: true,
				},
				{
					number: 13,
					url: "https://example.test/pull/13",
					ref: "kstack/next",
					baseRef: "kstack/top",
					headSha: sha,
					draft: false,
				},
			],
		});
	});

	it("returns command diagnostics for a failed query", async () => {
		const result = await query(fakeExec({ code: 1, stdout: "", stderr: "authentication required" }));
		assert.deepEqual(result, {
			ok: false,
			error: "Could not inspect open GitHub PRs: authentication required",
		});
	});

	it("rejects malformed JSON", async () => {
		const result = await query(fakeExec({ code: 0, stdout: "not json", stderr: "" }));
		assert.deepEqual(result, { ok: false, error: "GitHub returned invalid PR data." });
	});

	it("rejects the entire response when one row is invalid", async () => {
		const result = await query(
			fakeExec({ code: 0, stdout: JSON.stringify([validPullRequest, { ...validPullRequest, number: 0 }]), stderr: "" }),
		);
		assert.deepEqual(result, { ok: false, error: "GitHub returned invalid PR data." });
	});

	it("rejects responses above the item cap", async () => {
		const rows = Array.from({ length: MAX_OPEN_PRS + 1 }, (_, index) => ({
			...validPullRequest,
			number: index + 1,
		}));
		const result = await query(fakeExec({ code: 0, stdout: JSON.stringify(rows), stderr: "" }));
		assert.deepEqual(result, { ok: false, error: "GitHub returned invalid PR data." });
	});

	it("rejects unsafe refs and invalid SHAs", async () => {
		for (const row of [
			{ ...validPullRequest, headRefName: "kstack/top\nmain" },
			{ ...validPullRequest, baseRefName: "x".repeat(241) },
			{ ...validPullRequest, headRefOid: "not-a-sha" },
		]) {
			const result = await query(fakeExec({ code: 0, stdout: JSON.stringify([row]), stderr: "" }));
			assert.deepEqual(result, { ok: false, error: "GitHub returned invalid PR data." });
		}
	});

	it("passes the filter and clamps the requested limit", async () => {
		const calls: string[][] = [];
		await queryOpenPullRequests({
			exec: fakeExec({ code: 0, stdout: "[]", stderr: "" }, calls),
			cwd: "/repo",
			filter: ["--head", "kstack/top"],
			limit: MAX_OPEN_PRS + 10,
		});
		assert.deepEqual(calls[0]?.slice(0, 10), [
			"pr",
			"list",
			"--state",
			"open",
			"--head",
			"kstack/top",
			"--limit",
			String(MAX_OPEN_PRS),
			"--json",
			"number,url,headRefName,baseRefName,headRefOid,isDraft",
		]);
	});
});
