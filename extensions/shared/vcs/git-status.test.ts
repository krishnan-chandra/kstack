import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createVcsTestEnv } from "../vcs-test-env.ts";
import { gitStatusChangedPaths, parseGitStatus } from "./git-status.ts";

interface GitFixture {
	root: string;
	repo: string;
	env: NodeJS.ProcessEnv;
}

function runGit(fixture: Pick<GitFixture, "repo" | "env">, args: string[]): string {
	const completed = spawnSync("git", args, {
		cwd: fixture.repo,
		encoding: "utf8",
		env: fixture.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
	return completed.stdout;
}

function createFixture(): GitFixture {
	const root = mkdtempSync(join(tmpdir(), "git-status-"));
	const repo = join(root, "repo");
	mkdirSync(repo);
	const env = createVcsTestEnv(root);
	const fixture = { root, repo, env };
	runGit(fixture, ["init", "-q"]);
	writeFileSync(join(repo, "tracked.ts"), "keep\n");
	writeFileSync(join(repo, "delete-me.ts"), "gone\n");
	writeFileSync(join(repo, "old-name.ts"), "moved\n");
	runGit(fixture, ["add", "tracked.ts", "delete-me.ts", "old-name.ts"]);
	runGit(fixture, ["commit", "-qm", "init"]);
	return fixture;
}

function statusZ(fixture: GitFixture): string {
	return runGit(fixture, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
}

describe("parseGitStatus", () => {
	it("decodes a real Git status including rename, delete, untracked, spaces, and Unicode", () => {
		const fixture = createFixture();
		try {
			writeFileSync(join(fixture.repo, "tracked.ts"), "changed\n");
			runGit(fixture, ["rm", "-q", "delete-me.ts"]);
			runGit(fixture, ["mv", "old-name.ts", "new name.ts"]);
			writeFileSync(join(fixture.repo, "file with spaces.ts"), "untracked\n");
			writeFileSync(join(fixture.repo, "文件.ts"), "unicode\n");
			const parsed = parseGitStatus(statusZ(fixture));
			assert.equal(parsed.length, 5);
			assert.deepEqual(
				parsed.find((record) => record.origPath !== undefined),
				{ xy: "R ", path: "new name.ts", origPath: "old-name.ts" },
			);
			assert.deepEqual(
				new Set(parsed.filter((record) => record.xy === "??").map((record) => record.path)),
				new Set(["file with spaces.ts", "文件.ts"]),
			);
			assert.ok(parsed.some((record) => record.path === "delete-me.ts"));
			assert.ok(parsed.some((record) => record.path === "tracked.ts"));
			assert.equal(gitStatusChangedPaths(statusZ(fixture)).length, 6);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("parses plain, untracked, renamed, copied, and spaced entries", () => {
		const raw = "M  src/a.ts\0 M src/b b.ts\0?? new-file.ts\0R  new-name.ts\0old-name.ts\0C  copy.ts\0source.ts\0";
		assert.deepEqual(parseGitStatus(raw), [
			{ xy: "M ", path: "src/a.ts" },
			{ xy: " M", path: "src/b b.ts" },
			{ xy: "??", path: "new-file.ts" },
			{ xy: "R ", path: "new-name.ts", origPath: "old-name.ts" },
			{ xy: "C ", path: "copy.ts", origPath: "source.ts" },
		]);
	});

	it("treats a worktree-side rename as one record with both endpoints", () => {
		assert.deepEqual(parseGitStatus(" R dest.ts\0source.ts\0"), [{ xy: " R", path: "dest.ts", origPath: "source.ts" }]);
	});

	it("handles newlines in filenames", () => {
		assert.deepEqual(parseGitStatus("?? weird\nname.ts\0"), [{ xy: "??", path: "weird\nname.ts" }]);
	});

	it("ignores empty output and a trailing NUL", () => {
		assert.deepEqual(parseGitStatus(""), []);
		assert.deepEqual(parseGitStatus("?? a.ts\0"), [{ xy: "??", path: "a.ts" }]);
	});
});

describe("gitStatusChangedPaths", () => {
	it("returns unique destination then source paths for a rename", () => {
		assert.deepEqual(gitStatusChangedPaths("R  dest.ts\0source.ts\0?? scratch.txt\0"), [
			"dest.ts",
			"source.ts",
			"scratch.txt",
		]);
	});
});
