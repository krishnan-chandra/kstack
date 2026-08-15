import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGitHubAdapter, GitHubError } from "./github.ts";
import type { CommandResult } from "./process.ts";

describe("createDraftPr", () => {
	it("treats a created PR whose metadata cannot be re-read as indeterminate", async () => {
		const calls: string[][] = [];
		const adapter = createGitHubAdapter(async (argv) => {
			calls.push([...argv]);
			if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
				return { kind: "ok", code: 0, stdout: "https://github.com/o/r/pull/7\n", stderr: "" } satisfies CommandResult;
			}
			return { kind: "nonzero", code: 1, stdout: "", stderr: "lookup failed", message: "lookup failed" };
		});
		try {
			await adapter.createDraftPr({
				repo: { owner: "o", repo: "r" },
				bookmark: "feature",
				base: "main",
				title: "Title",
				cwd: ".",
			});
			assert.fail("expected createDraftPr to throw");
		} catch (error) {
			assert.ok(error instanceof GitHubError);
			assert.equal(error.kind, "indeterminate");
			assert.match(error.message, /Run plan again/);
		}
		assert.equal(calls[0]?.[2], "create");
	});

	it("treats a created comment whose id cannot be read as indeterminate", async () => {
		const adapter = createGitHubAdapter(async () => ({
			kind: "ok",
			code: 0,
			stdout: "{}",
			stderr: "",
		}));
		await assert.rejects(
			adapter.createOrUpdateComment({
				repo: { owner: "o", repo: "r" },
				prNumber: 7,
				body: "navigation",
				cwd: ".",
			}),
			(error: unknown) => error instanceof GitHubError && error.kind === "indeterminate",
		);
	});
});
