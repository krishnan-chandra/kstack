import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pinnedGitArgs, pinnedGitExec } from "./pinned-git.ts";

describe("pinnedGitArgs", () => {
	it("prefixes Git arguments with --no-replace-objects", () => {
		assert.deepEqual(pinnedGitArgs(["cat-file", "-e", "HEAD"]), ["--no-replace-objects", "cat-file", "-e", "HEAD"]);
		assert.deepEqual(pinnedGitArgs(["merge-base", "base", "head"]), [
			"--no-replace-objects",
			"merge-base",
			"base",
			"head",
		]);
		assert.deepEqual(pinnedGitArgs(["diff", "--name-status", "a..b"]), [
			"--no-replace-objects",
			"diff",
			"--name-status",
			"a..b",
		]);
	});

	it("idempotently preserves an existing --no-replace-objects prefix", () => {
		const args = ["--no-replace-objects", "diff", "a..b"];
		assert.deepEqual(pinnedGitArgs(args), args);
	});

	it("wraps a Git executor at the immutable-object boundary", () => {
		const calls: Array<{ args: string[]; cwd: string }> = [];
		const exec = pinnedGitExec((args, cwd) => {
			calls.push({ args, cwd });
			return "result";
		});

		assert.equal(exec(["log", "HEAD"], "/repo"), "result");
		assert.deepEqual(calls, [{ args: ["--no-replace-objects", "log", "HEAD"], cwd: "/repo" }]);
	});
});
