import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitBackend } from "../shared/vcs/git-backend.ts";
import { isForbiddenStagingPath } from "./github.ts";

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
		const backend = new GitBackend(async (cmd, args, _opts) => {
			capturedArgs = args;
			return { code: 0, stdout: output, stderr: "" };
		});

		const result = await backend.changedPaths("/repo");
		assert.ok(result.ok);

		// Must use the correct Git invocation
		assert.deepEqual(capturedArgs, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
		]);

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
		assert.equal(
			result.error,
			"Could not inspect working-copy changes: fatal: not a git repository",
		);
	});

	it("forbidden-path bridge: isForbiddenStagingPath blocks exact paths from changedPaths", () => {
		// The parser returns exact full paths; the autopilot predicate must
		// block the same strings that changedPaths() now returns losslessly.
		assert.equal(isForbiddenStagingPath(".github/workflows/ci.yml"), true);
		assert.equal(
			isForbiddenStagingPath("secrets/credentials.json"),
			true,
		);
		assert.equal(isForbiddenStagingPath(".env.local"), true);
		assert.equal(isForbiddenStagingPath(".env"), true);
		assert.equal(isForbiddenStagingPath("apps/web/.env.local"), true);
		// Safe paths are not blocked
		assert.equal(isForbiddenStagingPath("src/a.ts"), false);
		assert.equal(isForbiddenStagingPath("new.ts"), false);
		assert.equal(
			isForbiddenStagingPath("utils/untracked/nested.ts"),
			false,
		);
	});
});
