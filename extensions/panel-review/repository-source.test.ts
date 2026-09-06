import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { materializePrSnapshot } from "./pr-target.ts";
import { type CommandExec, gitStoreArgs, locateRepositorySource } from "./repository-source.ts";

interface Call {
	command: string;
	args: string[];
	cwd: string;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "panel-source-"));
	const real = realpathSync(root);
	mkdirSync(join(real, "store"), { recursive: true });
	mkdirSync(join(real, "ws", ".git"), { recursive: true });
	return { root: real, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const failingExec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "" });

function run(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv): string {
	const result = spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout.trim();
}

function realExec(env: NodeJS.ProcessEnv): ExecFn {
	return async (command, args, options) => {
		const result = spawnSync(command, args, {
			cwd: options.cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeout,
		});
		return {
			code: result.status ?? 1,
			stdout: result.stdout,
			stderr: result.stderr || result.error?.message || "",
		};
	};
}

describe("locateRepositorySource", () => {
	it("prefixes git calls with the jj object store and resolves gh -R from origin", async () => {
		const fx = fixture();
		try {
			const calls: Call[] = [];
			const commandExec: CommandExec = (command, args, cwd) => {
				calls.push({ command, args, cwd });
				const key = `${command} ${args.join(" ")}`;
				if (key === "jj workspace root") return `${fx.root}/ws\n`;
				if (key === "jj git root") return `${fx.root}/store\n`;
				if (key === `git --git-dir=${fx.root}/store remote get-url origin`) return "git@github.com:acme/widgets.git\n";
				if (key === `git --git-dir=${fx.root}/store log`) return "";
				throw new Error(`unexpected ${key}`);
			};
			const asyncCalls: string[][] = [];
			const exec: ExecFn = async (command, args) => {
				asyncCalls.push([command, ...args]);
				return { code: 0, stdout: "", stderr: "" };
			};
			const source = locateRepositorySource(join(fx.root, "ws", "sub"), exec, commandExec);
			assert.equal(source.layout, "jj-workspace");
			assert.equal(source.root, join(fx.root, "ws"));
			assert.equal(source.gitDir, join(fx.root, "store"));
			assert.equal(source.githubRepository, "acme/widgets");
			assert.equal(calls[0].cwd, join(fx.root, "ws", "sub"));

			source.git(["log"], source.root);
			assert.deepEqual(calls.at(-1)?.args, [`--git-dir=${fx.root}/store`, "log"]);
			await source.exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: source.root });
			assert.deepEqual(asyncCalls, [["git", `--git-dir=${fx.root}/store`, "rev-parse", "--absolute-git-dir"]]);
		} finally {
			fx.dispose();
		}
	});

	it("labels a colocated jj workspace whose store is its own .git", () => {
		const fx = fixture();
		try {
			const commandExec: CommandExec = (command, args) => {
				const key = `${command} ${args.join(" ")}`;
				if (key === "jj workspace root") return `${fx.root}/ws\n`;
				if (key === "jj git root") return `${fx.root}/ws/.git\n`;
				throw new Error("no origin");
			};
			const source = locateRepositorySource(join(fx.root, "ws"), failingExec, commandExec);
			assert.equal(source.layout, "jj-colocated");
			assert.equal(source.githubRepository, undefined);
		} finally {
			fx.dispose();
		}
	});

	it("falls back to a plain Git worktree without an explicit object store", async () => {
		const fx = fixture();
		try {
			const calls: Call[] = [];
			const commandExec: CommandExec = (command, args, cwd) => {
				calls.push({ command, args, cwd });
				const key = `${command} ${args.join(" ")}`;
				if (key === "jj workspace root") throw new Error("not jj");
				if (key === "git rev-parse --show-toplevel") return `${fx.root}/ws\n`;
				if (key === "git remote get-url origin") return "https://github.com/acme/widgets\n";
				if (key === "git status") return "";
				throw new Error(`unexpected ${key}`);
			};
			const asyncCalls: string[][] = [];
			const exec: ExecFn = async (command, args) => {
				asyncCalls.push([command, ...args]);
				return { code: 0, stdout: "", stderr: "" };
			};
			const source = locateRepositorySource(join(fx.root, "ws"), exec, commandExec);
			assert.equal(source.layout, "git-worktree");
			assert.equal(source.gitDir, undefined);
			assert.equal(source.githubRepository, "acme/widgets");
			source.git(["status"], source.root);
			assert.deepEqual(calls.at(-1)?.args, ["status"]);
			await source.exec("git", ["fetch"], { cwd: source.root });
			assert.deepEqual(asyncCalls, [["git", "fetch"]]);
		} finally {
			fx.dispose();
		}
	});

	it("materializes plain and linked Git worktrees without changing source state", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-source-layouts-"));
		const env = createVcsTestEnv(root);
		const repo = join(root, "repo");
		const linked = join(root, "linked");
		try {
			mkdirSync(repo);
			run(repo, "git", ["init", "-q"], env);
			writeFileSync(join(repo, "file.txt"), "main\n");
			run(repo, "git", ["add", "file.txt"], env);
			run(repo, "git", ["commit", "-qm", "main"], env);
			run(repo, "git", ["worktree", "add", "-q", "-b", "linked", linked], env);
			writeFileSync(join(linked, "file.txt"), "linked\n");
			run(linked, "git", ["commit", "-qam", "linked"], env);

			for (const fixture of [
				{ path: repo, expected: "main\n" },
				{ path: linked, expected: "linked\n" },
			]) {
				const commandExec: CommandExec = (command, args, cwd) => run(cwd, command, args, env);
				const source = locateRepositorySource(fixture.path, realExec(env), commandExec);
				const headSha = source.git(["rev-parse", "HEAD"], source.root).trim();
				const refsBefore = run(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"], env);
				const statusBefore = run(fixture.path, "git", ["status", "--porcelain=v1", "-uall"], env);
				const snapshot = await materializePrSnapshot(source.exec, source.root, headSha, {
					objectProcess: { env },
				});
				try {
					assert.equal(source.layout, "git-worktree");
					assert.equal(readFileSync(join(snapshot.directory, "file.txt"), "utf8"), fixture.expected);
					assert.equal(run(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"], env), refsBefore);
					assert.equal(run(fixture.path, "git", ["status", "--porcelain=v1", "-uall"], env), statusBefore);
				} finally {
					rmSync(snapshot.root, { recursive: true, force: true });
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects paths outside any repository", () => {
		const commandExec: CommandExec = () => {
			throw new Error("nothing here");
		};
		assert.throws(
			() => locateRepositorySource("/nowhere", failingExec, commandExec),
			/not inside a Git worktree or jj workspace/,
		);
	});

	it("gitStoreArgs leaves arguments alone without a store", () => {
		assert.deepEqual(gitStoreArgs(undefined, ["log"]), ["log"]);
		assert.deepEqual(gitStoreArgs("/s", ["log"]), ["--git-dir=/s", "log"]);
	});
});
