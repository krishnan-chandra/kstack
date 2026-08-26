import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGitHubGateway, GitHubError, parseAllowedMergeMethods, parseMergeCommit } from "../shared/github.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import type { CommandResult } from "./process.ts";

function gatewayFor(run: (argv: string[]) => Promise<CommandResult>) {
	return createGitHubGateway(async (command, args) => {
		const result = await run([command, ...args]);
		if (result.kind === "ok" || result.kind === "nonzero")
			return { code: result.code, stdout: result.stdout, stderr: result.stderr };
		throw new Error(result.message);
	});
}

describe("createDraftPr", () => {
	it("treats a created PR whose metadata cannot be re-read as indeterminate", async () => {
		const calls: string[][] = [];
		const adapter = gatewayFor(async (argv) => {
			calls.push([...argv]);
			if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "create") {
				return { kind: "ok", code: 0, stdout: "https://github.com/o/r/pull/7\n", stderr: "" } satisfies CommandResult;
			}
			return { kind: "nonzero", code: 1, stdout: "", stderr: "lookup failed", message: "lookup failed" };
		});
		try {
			await adapter.createDraftPr({
				repo: { owner: "o", repo: "r" },
				ref: "feature",
				base: "main",
				title: "Title",
				body: "## Summary\n\n- Add the feature.\n\n## Review guide\n\n1. **Flow** — Verify it.",
				cwd: ".",
			});
			assert.fail("expected createDraftPr to throw");
		} catch (error) {
			assert.ok(error instanceof GitHubError);
			assert.equal(error.kind, "indeterminate");
			assert.match(error.message, /Run plan again/);
		}
		assert.equal(calls[0]?.[2], "create");
		assert.ok(calls[0]?.includes("## Summary\n\n- Add the feature.\n\n## Review guide\n\n1. **Flow** — Verify it."));
	});

	it("treats a created comment whose id cannot be read as indeterminate", async () => {
		const adapter = gatewayFor(async () => ({
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
			(error: BoundaryValue) => error instanceof GitHubError && error.kind === "indeterminate",
		);
	});
});

describe("landing adapters", () => {
	it("parses allowed methods and merge commits", () => {
		assert.deepEqual(parseAllowedMergeMethods('{"squash":true,"rebase":false}', { owner: "o", repo: "r" }), ["squash"]);
		assert.deepEqual(
			parseMergeCommit('{"merged":true,"mergeCommitOid":"abc","headCommitId":"def","headRef":"feat"}', 7),
			{
				merged: true,
				mergeCommitOid: "abc",
				headCommitId: "def",
				headRef: "feat",
			},
		);
	});

	it("marks one PR ready and treats a missing branch delete as already-gone", async () => {
		const calls: string[][] = [];
		const adapter = gatewayFor(async (argv) => {
			calls.push([...argv]);
			if (argv.includes("-X") && argv.includes("DELETE")) {
				return { kind: "nonzero", code: 1, stdout: "", stderr: "HTTP 404: Not Found", message: "HTTP 404: Not Found" };
			}
			return { kind: "ok", code: 0, stdout: "", stderr: "" };
		});
		await adapter.markPrReady({ owner: "o", repo: "r" }, 11, ".");
		assert.deepEqual(calls[0], ["gh", "pr", "ready", "11", "--repo", "o/r"]);
		assert.equal(await adapter.deleteRemoteBranch({ owner: "o", repo: "r" }, "feat1", "."), "already-gone");
	});
});
