import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import { GitBackend } from "./git-backend.ts";

interface Step {
	command: string;
	args: string[];
	result?: Partial<ExecFnResult>;
}

function scriptedExec(steps: Step[]): ExecFn {
	return async (command, args) => {
		const step = steps.shift();
		assert.ok(step, `unexpected command: ${command} ${args.join(" ")}`);
		assert.equal(command, step.command);
		assert.deepEqual(args, step.args);
		return { code: step.result?.code ?? 0, stdout: step.result?.stdout ?? "", stderr: step.result?.stderr ?? "" };
	};
}

const HEAD = "1".repeat(40);

describe("GitBackend commitPaths", () => {
	it("adds the given paths and then commits", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["add", "--", "a.ts", "b.ts"] },
			{ command: "git", args: ["commit", "-m", "Apply fixes"] },
		]);
		assert.deepEqual(await new GitBackend(exec).commitPaths("/repo", ["a.ts", "b.ts"], "Apply fixes"), { ok: true });
	});

	it("does not commit when add fails", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["add", "--", "a.ts"], result: { code: 1, stderr: "pathspec did not match\n" } },
		]);
		assert.deepEqual(await new GitBackend(exec).commitPaths("/repo", ["a.ts"], "Apply fixes"), {
			ok: false,
			error: "git add failed: pathspec did not match",
		});
	});

	it("surfaces commit diagnostics after a successful add", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["add", "--", "a.ts"] },
			{ command: "git", args: ["commit", "-m", "Apply fixes"], result: { code: 1, stderr: "nothing to commit\n" } },
		]);
		assert.deepEqual(await new GitBackend(exec).commitPaths("/repo", ["a.ts"], "Apply fixes"), {
			ok: false,
			error: "git commit failed: nothing to commit",
		});
	});
});

describe("GitBackend restorePaths", () => {
	it("restores a tracked path without cleaning", async () => {
		const exec = scriptedExec([{ command: "git", args: ["restore", "--staged", "--worktree", "--", "tracked.ts"] }]);
		assert.deepEqual(await new GitBackend(exec).restorePaths("/repo", ["tracked.ts"]), { ok: true });
	});

	it("falls back to a path-scoped clean when restore fails", async () => {
		const exec = scriptedExec([
			{
				command: "git",
				args: ["restore", "--staged", "--worktree", "--", "untracked.ts"],
				result: { code: 1, stderr: "pathspec did not match\n" },
			},
			{ command: "git", args: ["clean", "-f", "--", "untracked.ts"] },
		]);
		assert.deepEqual(await new GitBackend(exec).restorePaths("/repo", ["untracked.ts"]), { ok: true });
	});

	it("aggregates path-scoped failures without a broad clean", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["restore", "--staged", "--worktree", "--", "ok.ts"] },
			{
				command: "git",
				args: ["restore", "--staged", "--worktree", "--", "bad.ts"],
				result: { code: 1, stderr: "restore denied\n" },
			},
			{ command: "git", args: ["clean", "-f", "--", "bad.ts"], result: { code: 1, stderr: "clean denied\n" } },
		]);
		assert.deepEqual(await new GitBackend(exec).restorePaths("/repo", ["ok.ts", "bad.ts"]), {
			ok: false,
			error: "bad.ts: restore denied",
		});
	});
});

describe("GitBackend removeIsolation", () => {
	it("does not delete the branch when worktree removal fails", async () => {
		const exec = scriptedExec([
			{
				command: "git",
				args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
				result: { stdout: "/repo/.git\n" },
			},
			{
				command: "git",
				args: ["worktree", "remove", "/worktree", "--force"],
				result: { code: 1, stderr: "worktree locked\n" },
			},
		]);
		assert.deepEqual(await new GitBackend(exec).removeIsolation("/worktree", "kstack/task"), {
			ok: false,
			error: "Worktree removal failed: worktree locked. You may need to remove it manually.",
		});
	});

	it("removes the worktree and then deletes the branch", async () => {
		const exec = scriptedExec([
			{
				command: "git",
				args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
				result: { stdout: "/repo/.git\n" },
			},
			{ command: "git", args: ["worktree", "remove", "/worktree", "--force"] },
			{ command: "git", args: ["branch", "-d", "kstack/task"] },
		]);
		assert.deepEqual(await new GitBackend(exec).removeIsolation("/worktree", "kstack/task"), { ok: true });
	});

	it("returns ok with a warning when branch deletion fails", async () => {
		const exec = scriptedExec([
			{
				command: "git",
				args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
				result: { stdout: "/repo/.git\n" },
			},
			{ command: "git", args: ["worktree", "remove", "/worktree", "--force"] },
			{
				command: "git",
				args: ["branch", "-d", "kstack/task"],
				result: { code: 1, stderr: "not fully merged\n" },
			},
		]);
		assert.deepEqual(await new GitBackend(exec).removeIsolation("/worktree", "kstack/task"), {
			ok: true,
			warning: "Branch deletion warning: not fully merged",
		});
	});
});

describe("GitBackend mergeBaseIntoHead", () => {
	it("returns failed when fetch fails", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"], result: { code: 1, stderr: "network down\n" } },
		]);
		assert.deepEqual(await new GitBackend(exec).mergeBaseIntoHead("/repo", "main"), {
			kind: "failed",
			error: "git fetch origin main failed: network down",
		});
	});

	it("returns already-current when the merge reports no work", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{
				command: "git",
				args: ["merge", "--no-edit", "origin/main"],
				result: { stdout: "Already up to date.\n" },
			},
		]);
		assert.deepEqual(await new GitBackend(exec).mergeBaseIntoHead("/repo", "main"), { kind: "already-current" });
	});

	it("returns clean with the new HEAD after a successful merge", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{
				command: "git",
				args: ["merge", "--no-edit", "origin/main"],
				result: { stdout: "Merge made by the recursive strategy.\n" },
			},
			{ command: "git", args: ["rev-parse", "HEAD"], result: { stdout: `${HEAD}\n` } },
		]);
		assert.deepEqual(await new GitBackend(exec).mergeBaseIntoHead("/repo", "main"), {
			kind: "clean",
			headSha: HEAD,
		});
	});

	it("aborts and returns needs-human with the unmerged files", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{
				command: "git",
				args: ["merge", "--no-edit", "origin/main"],
				result: { code: 1, stderr: "Automatic merge failed\n" },
			},
			{
				command: "git",
				args: ["diff", "--name-only", "--diff-filter=U"],
				result: { stdout: "src/a.ts\nsrc/b.ts\n" },
			},
			{ command: "git", args: ["merge", "--abort"] },
		]);
		assert.deepEqual(await new GitBackend(exec).mergeBaseIntoHead("/repo", "main"), {
			kind: "needs-human",
			files: ["src/a.ts", "src/b.ts"],
			error: "Merge of origin/main conflicted in src/a.ts, src/b.ts. Competing intents need a human.",
		});
	});

	it("aborts and returns failed when a merge fails with no unmerged files", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{
				command: "git",
				args: ["merge", "--no-edit", "origin/main"],
				result: { code: 1, stderr: "not something we can merge\n" },
			},
			{ command: "git", args: ["diff", "--name-only", "--diff-filter=U"] },
			{ command: "git", args: ["merge", "--abort"] },
		]);
		assert.deepEqual(await new GitBackend(exec).mergeBaseIntoHead("/repo", "main"), {
			kind: "failed",
			error: "git merge origin/main failed: not something we can merge",
		});
	});
});
