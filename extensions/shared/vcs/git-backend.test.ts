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
const MERGED_HEAD = "2".repeat(40);

describe("GitBackend recordPaths", () => {
	it("adds the given paths and then commits", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["add", "--", "a.ts", "b.ts"] },
			{ command: "git", args: ["commit", "-m", "Apply fixes"] },
		]);
		assert.deepEqual(await new GitBackend(exec).recordPaths("/repo", ["a.ts", "b.ts"], "Apply fixes"), { ok: true });
	});

	it("does not commit when add fails", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["add", "--", "a.ts"], result: { code: 1, stderr: "pathspec did not match\n" } },
		]);
		assert.deepEqual(await new GitBackend(exec).recordPaths("/repo", ["a.ts"], "Apply fixes"), {
			ok: false,
			error: "git add failed: pathspec did not match",
		});
	});

	it("surfaces commit diagnostics after a successful add", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["add", "--", "a.ts"] },
			{ command: "git", args: ["commit", "-m", "Apply fixes"], result: { code: 1, stderr: "nothing to commit\n" } },
		]);
		assert.deepEqual(await new GitBackend(exec).recordPaths("/repo", ["a.ts"], "Apply fixes"), {
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

describe("GitBackend isolation.remove", () => {
	const cwd = "/managed/task";
	const deps = { managedRoot: "/managed", realpath: (path: string) => path };
	const listed = `worktree ${cwd}\0HEAD ${HEAD}\0branch refs/heads/kstack/task\0\0`;
	const preflight: Step[] = [
		{
			command: "git",
			args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
			result: { stdout: "/repo/.git\n" },
		},
		{ command: "git", args: ["worktree", "list", "--porcelain", "-z"], result: { stdout: listed } },
		{ command: "git", args: ["status", "--porcelain=v1", "--untracked-files=all"] },
	];

	it("rejects a worktree outside the managed root without running Git", async () => {
		assert.deepEqual(await new GitBackend(scriptedExec([]), deps).isolation.remove("/other/task", "kstack/task"), {
			ok: false,
			error: "Refusing to remove a worktree outside the managed root /managed.",
		});
	});

	it("rejects a path that is not registered as a Git worktree", async () => {
		const exec = scriptedExec([
			preflight[0],
			{ command: "git", args: ["worktree", "list", "--porcelain", "-z"], result: { stdout: "" } },
		]);
		assert.deepEqual(await new GitBackend(exec, deps).isolation.remove(cwd, "kstack/task"), {
			ok: false,
			error: `Git does not list ${cwd} as an authoritative worktree.`,
		});
	});

	it("rejects a worktree whose branch no longer matches", async () => {
		const mismatch = `worktree ${cwd}\0HEAD ${HEAD}\0branch refs/heads/kstack/other\0\0`;
		const exec = scriptedExec([
			preflight[0],
			{ command: "git", args: ["worktree", "list", "--porcelain", "-z"], result: { stdout: mismatch } },
		]);
		assert.deepEqual(await new GitBackend(exec, deps).isolation.remove(cwd, "kstack/task"), {
			ok: false,
			error: "Worktree branch changed: expected kstack/task, found kstack/other.",
		});
	});

	it("preserves a dirty managed worktree", async () => {
		const steps = [...preflight];
		steps[2] = { ...steps[2], result: { stdout: "?? notes.txt\n" } };
		assert.deepEqual(await new GitBackend(scriptedExec(steps), deps).isolation.remove(cwd, "kstack/task"), {
			ok: false,
			error: `Worktree ${cwd} has uncommitted or untracked files; cleanup preserved it.`,
		});
	});

	it("rejects a locked authoritative worktree before inspecting files", async () => {
		const locked = `worktree ${cwd}\0HEAD ${HEAD}\0branch refs/heads/kstack/task\0locked reason\0\0`;
		assert.deepEqual(
			await new GitBackend(
				scriptedExec([
					preflight[0],
					{ command: "git", args: ["worktree", "list", "--porcelain", "-z"], result: { stdout: locked } },
				]),
				deps,
			).isolation.remove(cwd, "kstack/task"),
			{ ok: false, error: `Worktree ${cwd} is locked; unlock it before cleanup.` },
		);
	});

	it("does not delete the branch when worktree removal fails", async () => {
		const exec = scriptedExec([
			...preflight,
			{
				command: "git",
				args: ["worktree", "remove", cwd],
				result: { code: 1, stderr: "worktree locked\n" },
			},
		]);
		assert.deepEqual(await new GitBackend(exec, deps).isolation.remove(cwd, "kstack/task"), {
			ok: false,
			error: "Worktree removal failed: worktree locked. You may need to remove it manually.",
		});
	});

	it("removes a clean authoritative worktree without force and then deletes the branch", async () => {
		const exec = scriptedExec([
			...preflight,
			{ command: "git", args: ["worktree", "remove", cwd] },
			{ command: "git", args: ["branch", "-d", "kstack/task"] },
		]);
		assert.deepEqual(await new GitBackend(exec, deps).isolation.remove(cwd, "kstack/task"), { ok: true });
	});

	it("returns ok with a warning when branch deletion fails", async () => {
		const exec = scriptedExec([
			...preflight,
			{ command: "git", args: ["worktree", "remove", cwd] },
			{
				command: "git",
				args: ["branch", "-d", "kstack/task"],
				result: { code: 1, stderr: "not fully merged\n" },
			},
		]);
		assert.deepEqual(await new GitBackend(exec, deps).isolation.remove(cwd, "kstack/task"), {
			ok: true,
			warning: "Branch deletion warning: not fully merged",
		});
	});
});

describe("GitBackend updateBase", () => {
	it("returns failed when fetch fails", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"], result: { code: 1, stderr: "network down\n" } },
		]);
		assert.deepEqual(await new GitBackend(exec).updateBase("/repo", "main"), {
			kind: "failed",
			error: "git fetch origin main failed: network down",
		});
	});

	it("returns already-current when a localized no-op merge leaves HEAD unchanged", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{ command: "git", args: ["rev-parse", "HEAD"], result: { stdout: `${HEAD}\n` } },
			{
				command: "git",
				args: ["merge", "--no-edit", "origin/main"],
				result: { stdout: "Déjà à jour.\n" },
			},
			{ command: "git", args: ["rev-parse", "HEAD"], result: { stdout: `${HEAD}\n` } },
		]);
		assert.deepEqual(await new GitBackend(exec).updateBase("/repo", "main"), { kind: "already-current" });
	});

	it("returns clean with the new HEAD after a successful merge", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{ command: "git", args: ["rev-parse", "HEAD"], result: { stdout: `${HEAD}\n` } },
			{
				command: "git",
				args: ["merge", "--no-edit", "origin/main"],
				result: { stdout: "Merge made by the recursive strategy.\n" },
			},
			{ command: "git", args: ["rev-parse", "HEAD"], result: { stdout: `${MERGED_HEAD}\n` } },
		]);
		assert.deepEqual(await new GitBackend(exec).updateBase("/repo", "main"), {
			kind: "clean",
			headSha: MERGED_HEAD,
		});
	});

	it("does not merge when the pre-merge HEAD cannot be read", async () => {
		const steps: Step[] = [
			{ command: "git", args: ["fetch", "origin", "main"] },
			{ command: "git", args: ["rev-parse", "HEAD"], result: { code: 1, stderr: "bad HEAD\n" } },
		];
		assert.deepEqual(await new GitBackend(scriptedExec(steps)).updateBase("/repo", "main"), {
			kind: "failed",
			error: "Could not read HEAD before merging origin/main: Could not resolve the current HEAD: bad HEAD",
		});
		assert.equal(steps.length, 0);
	});

	it("aborts and returns needs-human with the unmerged files", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{ command: "git", args: ["rev-parse", "HEAD"], result: { stdout: `${HEAD}\n` } },
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
		assert.deepEqual(await new GitBackend(exec).updateBase("/repo", "main"), {
			kind: "needs-human",
			files: ["src/a.ts", "src/b.ts"],
			error: "Merge of origin/main conflicted in src/a.ts, src/b.ts. Competing intents need a human.",
		});
	});

	it("aborts and returns failed when a merge fails with no unmerged files", async () => {
		const exec = scriptedExec([
			{ command: "git", args: ["fetch", "origin", "main"] },
			{ command: "git", args: ["rev-parse", "HEAD"], result: { stdout: `${HEAD}\n` } },
			{
				command: "git",
				args: ["merge", "--no-edit", "origin/main"],
				result: { code: 1, stderr: "not something we can merge\n" },
			},
			{ command: "git", args: ["diff", "--name-only", "--diff-filter=U"] },
			{ command: "git", args: ["merge", "--abort"] },
		]);
		assert.deepEqual(await new GitBackend(exec).updateBase("/repo", "main"), {
			kind: "failed",
			error: "git merge origin/main failed: not something we can merge",
		});
	});
});
