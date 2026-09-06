import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
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
			await source.exec("git", ["archive"], { cwd: source.root });
			await source.exec("tar", ["-xf", "x"], { cwd: source.root });
			assert.deepEqual(asyncCalls, [
				["git", `--git-dir=${fx.root}/store`, "archive"],
				["tar", "-xf", "x"],
			]);
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
