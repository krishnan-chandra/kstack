import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createVcsTestEnv } from "../vcs-test-env.ts";
import { parseWorktreeInventory } from "./worktree-inventory.ts";

const SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);

interface GitFixture {
	root: string;
	repo: string;
	env: NodeJS.ProcessEnv;
}

function runGit(fixture: Pick<GitFixture, "repo" | "env">, args: string[], cwd = fixture.repo): string {
	const completed = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: fixture.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
	return completed.stdout;
}

function createFixture(): GitFixture {
	const root = mkdtempSync(join(tmpdir(), "worktree-inventory-"));
	const repo = join(root, "repo");
	mkdirSync(repo);
	const env = createVcsTestEnv(root);
	const fixture = { root, repo, env };
	runGit(fixture, ["init", "-q"]);
	writeFileSync(join(repo, "init.txt"), "init\n");
	runGit(fixture, ["add", "init.txt"]);
	runGit(fixture, ["commit", "-qm", "init"]);
	runGit(fixture, ["branch", "-M", "main"]);
	return fixture;
}

function record(path: string, fields: string): string {
	return `worktree ${path}\0${fields}\0\0`;
}

describe("parseWorktreeInventory", () => {
	it("decodes a real Git inventory including lock reasons and a spaced path", () => {
		const fixture = createFixture();
		try {
			const repoPath = realpathSync(fixture.repo);
			const linked = join(fixture.root, "linked worktree");
			const head = runGit(fixture, ["rev-parse", "HEAD"]).trim();
			runGit(fixture, ["worktree", "add", "-q", "-b", "kstack/task", linked, "HEAD"]);
			const linkedPath = realpathSync(linked);
			runGit(fixture, ["worktree", "lock", "--reason", "build in progress", linked]);
			const stdout = runGit(fixture, ["worktree", "list", "--porcelain", "-z"]);
			const parsed = parseWorktreeInventory(stdout);
			assert.equal(parsed.ok, true);
			if (!parsed.ok) return;
			assert.equal(parsed.value.length, 2);
			const primary = parsed.value.find((item) => item.branch === "main");
			assert.ok(primary);
			assert.equal(realpathSync(primary.path), repoPath);
			assert.deepEqual(
				{ ...primary, path: repoPath },
				{
					path: repoPath,
					head,
					branch: "main",
					bare: false,
					detached: false,
					locked: false,
					prunable: false,
				},
			);
			const managed = parsed.value.find((item) => item.branch === "kstack/task");
			assert.ok(managed);
			assert.equal(realpathSync(managed.path), linkedPath);
			assert.deepEqual(
				{ ...managed, path: linkedPath },
				{
					path: linkedPath,
					head,
					branch: "kstack/task",
					bare: false,
					detached: false,
					locked: "build in progress",
					prunable: false,
				},
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("decodes detached HEAD and a lock without a reason", () => {
		const fixture = createFixture();
		try {
			const linked = join(fixture.root, "detached");
			const head = runGit(fixture, ["rev-parse", "HEAD"]).trim();
			runGit(fixture, ["worktree", "add", "-q", "--detach", linked, "HEAD"]);
			const linkedPath = realpathSync(linked);
			runGit(fixture, ["worktree", "lock", linked]);
			const stdout = runGit(fixture, ["worktree", "list", "--porcelain", "-z"]);
			const parsed = parseWorktreeInventory(stdout);
			assert.equal(parsed.ok, true);
			if (!parsed.ok) return;
			const managed = parsed.value.find((item) => item.detached);
			assert.ok(managed);
			assert.equal(realpathSync(managed.path), linkedPath);
			assert.deepEqual(
				{ ...managed, path: linkedPath },
				{
					path: linkedPath,
					head,
					branch: undefined,
					bare: false,
					detached: true,
					locked: true,
					prunable: false,
				},
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("retains prunable reasons and accepts bare records", () => {
		const top = record("/repo", `HEAD ${SHA}\0branch refs/heads/main`);
		const locked = parseWorktreeInventory(`${top.slice(0, -2)}\0locked\0\0`);
		assert.equal(locked.ok, true);
		if (locked.ok) assert.equal(locked.value[0]?.locked, true);

		const prunable = parseWorktreeInventory(
			`worktree /gone\0HEAD ${SHA}\0branch refs/heads/kstack/gone\0prunable gitdir file points to non-existent location\0\0`,
		);
		assert.equal(prunable.ok, true);
		if (prunable.ok) {
			assert.equal(prunable.value[0]?.prunable, "gitdir file points to non-existent location");
			assert.equal(prunable.value[0]?.branch, "kstack/gone");
		}

		const bare = parseWorktreeInventory(`worktree /bare.git\0bare\0\0${top}`);
		assert.equal(bare.ok, true);
		if (bare.ok) {
			assert.deepEqual(bare.value[0], {
				path: "/bare.git",
				head: undefined,
				branch: undefined,
				bare: true,
				detached: false,
				locked: false,
				prunable: false,
			});
		}
	});

	it("rejects empty, unterminated, and malformed inventories", () => {
		const valid = record("/repo", `HEAD ${SHA}\0branch refs/heads/main`);
		const cases: Array<{ label: string; stdout: string; error: RegExp }> = [
			{ label: "empty", stdout: "", error: /empty or unterminated/ },
			{ label: "unterminated", stdout: valid.slice(0, -1), error: /empty or unterminated/ },
			{
				label: "empty path",
				stdout: `worktree \0HEAD ${SHA}\0branch refs/heads/main\0\0`,
				error: /invalid worktree record/,
			},
			{
				label: "duplicate path",
				stdout: `${valid}${record("/repo", `HEAD ${OTHER_SHA}\0branch refs/heads/other`)}`,
				error: /duplicate worktree records/,
			},
			{
				label: "invalid branch",
				stdout: record("/repo", `HEAD ${SHA}\0branch refs/remotes/origin/main`),
				error: /invalid worktree branch record/,
			},
			{
				label: "unknown attribute",
				stdout: record("/repo", `HEAD ${SHA}\0branch refs/heads/main\0extra`),
				error: /invalid worktree record/,
			},
			{ label: "missing HEAD", stdout: record("/repo", "branch refs/heads/main"), error: /incomplete worktree record/ },
			{
				label: "invalid HEAD",
				stdout: record("/repo", "HEAD abc\0branch refs/heads/main"),
				error: /incomplete worktree record/,
			},
			{
				label: "branch and detached",
				stdout: record("/repo", `HEAD ${SHA}\0branch refs/heads/main\0detached`),
				error: /incomplete worktree record/,
			},
			{
				label: "duplicate locked",
				stdout: record("/repo", `HEAD ${SHA}\0branch refs/heads/main\0locked\0locked again`),
				error: /invalid worktree record/,
			},
			{ label: "separator only", stdout: "\0\0", error: /invalid worktree record|empty worktree inventory/ },
		];
		for (const testCase of cases) {
			const parsed = parseWorktreeInventory(testCase.stdout);
			assert.equal(parsed.ok, false, testCase.label);
			if (!parsed.ok) assert.match(parsed.error, testCase.error, testCase.label);
		}
	});
});
