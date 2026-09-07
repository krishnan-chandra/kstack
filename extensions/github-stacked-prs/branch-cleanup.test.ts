import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { type CleanupLocalBranchInput, type CleanupLocalBranchResult, cleanupLocalBranch } from "./branch-cleanup.ts";

interface TestFixture {
	root: string;
	repo: string;
	env: NodeJS.ProcessEnv;
	exec: ExecFn;
}

function runGit(fixture: Pick<TestFixture, "repo" | "env">, args: string[], cwd = fixture.repo): string {
	const completed = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: fixture.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
	return completed.stdout.trim();
}

function commitFile(
	fixture: Pick<TestFixture, "repo" | "env">,
	name: string,
	contents: string,
	message: string,
): string {
	writeFileSync(join(fixture.repo, name), contents, "utf8");
	runGit(fixture, ["add", name]);
	runGit(fixture, ["commit", "-qm", message]);
	return runGit(fixture, ["rev-parse", "HEAD"]);
}

function createRealExec(env: NodeJS.ProcessEnv): ExecFn {
	return (command, args, options) => {
		const completed = spawnSync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeout,
		});
		return Promise.resolve({
			code: completed.status ?? 1,
			stdout: completed.stdout,
			stderr: completed.stderr || completed.error?.message || "",
		});
	};
}

function createFixture(): TestFixture {
	const root = mkdtempSync(join(tmpdir(), "branch-cleanup-test-"));
	const repo = join(root, "repo");
	mkdirSync(repo);
	const env = createVcsTestEnv(root);
	const fixture = { root, repo, env, exec: createRealExec(env) };
	runGit(fixture, ["init", "-q"]);
	commitFile(fixture, "init.txt", "init\n", "initial commit");
	runGit(fixture, ["branch", "-M", "main"]);
	return fixture;
}

describe("cleanupLocalBranch", () => {
	it("deletes an ordinary un-checked-out local branch at the expected head SHA", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-qc", "kstack/one"]);
			const sha = commitFile(fixture, "one.txt", "one\n", "one");
			runGit(fixture, ["switch", "-q", "main"]);

			const input: CleanupLocalBranchInput = {
				branch: "kstack/one",
				expectedHeadSha: sha,
				cwd: fixture.repo,
				exec: fixture.exec,
			};
			const result: CleanupLocalBranchResult = await cleanupLocalBranch(input);

			assert.deepEqual(result.completedMutations, ["Deleted local branch kstack/one"]);
			assert.deepEqual(result.warnings, []);
			const check = spawnSync("git", ["rev-parse", "--verify", "refs/heads/kstack/one"], {
				cwd: fixture.repo,
				encoding: "utf8",
				env: fixture.env,
			});
			assert.notEqual(check.status, 0);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("short-circuits when the local branch is already missing with zero mutations and zero warnings", async () => {
		const fixture = createFixture();
		try {
			const result = await cleanupLocalBranch({
				branch: "kstack/nonexistent",
				expectedHeadSha: "a".repeat(40),
				cwd: fixture.repo,
				exec: fixture.exec,
			});

			assert.deepEqual(result.completedMutations, []);
			assert.deepEqual(result.warnings, []);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("warns when ref verification fails fatally with empty stdout", async () => {
		const fixture = createFixture();
		try {
			const exec: ExecFn = async (command, args, options) => {
				if (args[0] === "rev-parse") {
					return { code: 128, stdout: "", stderr: "fatal: unable to read repository" };
				}
				assert.notEqual(args[0], "update-ref");
				return fixture.exec(command, args, options);
			};
			const result = await cleanupLocalBranch({
				branch: "kstack/one",
				expectedHeadSha: "a".repeat(40),
				cwd: fixture.repo,
				exec,
			});
			assert.deepEqual(result.completedMutations, []);
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /Could not verify local branch.*unable to read repository/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("preserves a local branch that moved to another commit and returns a warning", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-qc", "kstack/one"]);
			const oldSha = commitFile(fixture, "one.txt", "one\n", "one");
			const newSha = commitFile(fixture, "two.txt", "two\n", "two");
			runGit(fixture, ["switch", "-q", "main"]);

			const result = await cleanupLocalBranch({
				branch: "kstack/one",
				expectedHeadSha: oldSha,
				cwd: fixture.repo,
				exec: fixture.exec,
			});

			assert.deepEqual(result.completedMutations, []);
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /local head changed to/);
			assert.ok(result.warnings[0].includes(newSha));
			const head = runGit(fixture, ["rev-parse", "refs/heads/kstack/one"]);
			assert.equal(head, newSha);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("preserves a branch checked out in a linked worktree and returns a warning", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-qc", "kstack/one"]);
			const sha = commitFile(fixture, "one.txt", "one\n", "one");
			runGit(fixture, ["switch", "-q", "main"]);

			const linkedWorktree = join(fixture.root, "linked-wt");
			runGit(fixture, ["worktree", "add", "-q", linkedWorktree, "kstack/one"]);

			const result = await cleanupLocalBranch({
				branch: "kstack/one",
				expectedHeadSha: sha,
				cwd: fixture.repo,
				exec: fixture.exec,
			});

			assert.deepEqual(result.completedMutations, []);
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /checked out in worktree/);
			const head = runGit(fixture, ["rev-parse", "refs/heads/kstack/one"]);
			assert.equal(head, sha);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects deleting a symbolic ref and returns a warning", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["symbolic-ref", "refs/heads/kstack/sym", "refs/heads/main"]);
			const mainSha = runGit(fixture, ["rev-parse", "refs/heads/main"]);

			const result = await cleanupLocalBranch({
				branch: "kstack/sym",
				expectedHeadSha: mainSha,
				cwd: fixture.repo,
				exec: fixture.exec,
			});

			assert.deepEqual(result.completedMutations, []);
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /ref is a symbolic ref/);
			const sym = runGit(fixture, ["symbolic-ref", "refs/heads/kstack/sym"]);
			assert.equal(sym, "refs/heads/main");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("fails closed and retains the branch when worktree inventory is unreadable or malformed", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-qc", "kstack/one"]);
			const sha = commitFile(fixture, "one.txt", "one\n", "one");
			runGit(fixture, ["switch", "-q", "main"]);

			const failingExec: ExecFn = async (command, args, options) => {
				if (args[0] === "worktree" && args[1] === "list") {
					return { code: 1, stdout: "", stderr: "fatal: git worktree list failed" };
				}
				return fixture.exec(command, args, options);
			};

			const result = await cleanupLocalBranch({
				branch: "kstack/one",
				expectedHeadSha: sha,
				cwd: fixture.repo,
				exec: failingExec,
			});

			assert.deepEqual(result.completedMutations, []);
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /Could not inspect Git worktrees/);
			const head = runGit(fixture, ["rev-parse", "refs/heads/kstack/one"]);
			assert.equal(head, sha);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("retains branch configuration in .git/config after deleting the ref", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-qc", "kstack/one"]);
			const sha = commitFile(fixture, "one.txt", "one\n", "one");
			runGit(fixture, ["switch", "-q", "main"]);

			runGit(fixture, ["config", "branch.kstack/one.description", "preserved description"]);
			runGit(fixture, ["config", "branch.kstack/one.remote", "origin"]);

			const result = await cleanupLocalBranch({
				branch: "kstack/one",
				expectedHeadSha: sha,
				cwd: fixture.repo,
				exec: fixture.exec,
			});

			assert.deepEqual(result.completedMutations, ["Deleted local branch kstack/one"]);
			assert.deepEqual(result.warnings, []);

			const desc = runGit(fixture, ["config", "branch.kstack/one.description"]);
			assert.equal(desc, "preserved description");
			const remote = runGit(fixture, ["config", "branch.kstack/one.remote"]);
			assert.equal(remote, "origin");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("warns when update-ref fails after pre-read matched the expected head", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-qc", "kstack/one"]);
			const sha = commitFile(fixture, "one.txt", "one\n", "one");
			runGit(fixture, ["switch", "-q", "main"]);

			const racingExec: ExecFn = async (command, args, options) => {
				if (args[0] === "update-ref") {
					return { code: 1, stdout: "", stderr: "fatal: update-ref failed" };
				}
				return fixture.exec(command, args, options);
			};

			const result = await cleanupLocalBranch({
				branch: "kstack/one",
				expectedHeadSha: sha,
				cwd: fixture.repo,
				exec: racingExec,
			});

			assert.deepEqual(result.completedMutations, []);
			assert.equal(result.warnings.length, 1);
			assert.match(result.warnings[0], /ref head changed or could not be locked/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
