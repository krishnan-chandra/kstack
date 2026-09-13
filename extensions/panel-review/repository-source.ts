/**
 * Locate the repository behind a path independently of what is reviewed.
 *
 * A review target (working tree, jj revision, PR) needs two things from the
 * repository: a directory to run commands in and a Git object store. In a Git
 * worktree the store is implicit. In a jj workspace it is wherever `jj git
 * root` points, which for `--no-colocate` repositories and secondary
 * `jj workspace add` workspaces is not under the workspace at all. Resolving
 * that once here lets every Git and GitHub call use the same executors.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecFn } from "../shared/git-exec.ts";
import { parseGithubUrl } from "../shared/github.ts";
import type { GitExec } from "./review-scope.ts";

type RepositoryLayout = "git-worktree" | "jj-colocated" | "jj-workspace";

/** Synchronous command runner used for repository discovery. */
export type CommandExec = (command: string, args: string[], cwd: string) => string;

export const defaultCommandExec: CommandExec = (command, args, cwd) =>
	execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

export interface RepositorySource {
	/** Canonical directory commands run in: the Git worktree or jj workspace root. */
	root: string;
	layout: RepositoryLayout;
	/** Explicit Git object store for jj layouts; undefined when `root` owns its `.git`. */
	gitDir: string | undefined;
	/** Synchronous Git runner with the object store baked in. */
	git: GitExec;
	/** Asynchronous runner with the object store baked into `git` invocations. */
	exec: ExecFn;
	/** GitHub `owner/name` from the `origin` remote, for `gh -R` outside a Git worktree. */
	githubRepository: string | undefined;
}

export function tryCommand(exec: CommandExec, command: string, args: string[], cwd: string): string | null {
	try {
		return exec(command, args, cwd);
	} catch {
		return null;
	}
}

/** Prefix Git argument lists with an explicit object store when one is needed. */
export function gitStoreArgs(gitDir: string | undefined, args: string[]): string[] {
	return gitDir === undefined ? args : [`--git-dir=${gitDir}`, ...args];
}

function describeLayout(root: string, gitDir: string): RepositoryLayout {
	return gitDir === join(root, ".git") ? "jj-colocated" : "jj-workspace";
}

function resolveGithubRepository(git: GitExec, root: string): string | undefined {
	let url: string;
	try {
		url = git(["remote", "get-url", "origin"], root).trim();
	} catch {
		return undefined;
	}
	const parsed = parseGithubUrl(url);
	return parsed ? `${parsed.owner}/${parsed.repo}` : undefined;
}

/**
 * Turn a `--repo` argument into an absolute path. Slash-command arguments never
 * pass through a shell, so a leading `~` is expanded here; everything else is
 * resolved against the session cwd.
 */
export function resolveRepositoryPath(cwd: string, requested: string, home: string = homedir()): string {
	if (requested === "~") return home;
	if (requested.startsWith("~/")) return join(home, requested.slice(2));
	return resolve(cwd, requested);
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resolve the repository at `path`. A jj workspace wins over a plain Git
 * worktree because colocated repositories satisfy both checks and jj owns the
 * working copy there.
 */
export function locateRepositorySource(
	path: string,
	exec: ExecFn,
	commandExec: CommandExec = defaultCommandExec,
): RepositorySource {
	if (!isDirectory(path))
		throw new Error(`${path} is not a directory. Pass --repo <path> to an existing Git worktree or jj workspace.`);
	const workspace = tryCommand(commandExec, "jj", ["workspace", "root"], path)?.trim();
	let root: string;
	let gitDir: string | undefined;
	let layout: RepositoryLayout;
	if (workspace) {
		const gitRoot = tryCommand(commandExec, "jj", ["git", "root"], workspace)?.trim();
		if (!gitRoot) throw new Error(`${workspace} is a jj workspace without a Git object store.`);
		root = realpathSync(workspace);
		gitDir = realpathSync(gitRoot);
		layout = describeLayout(root, gitDir);
	} else {
		const top = tryCommand(commandExec, "git", ["rev-parse", "--show-toplevel"], path)?.trim();
		if (!top) throw new Error(`${path} is not inside a Git worktree or jj workspace.`);
		root = realpathSync(top);
		gitDir = undefined;
		layout = "git-worktree";
	}
	const git: GitExec = (args, cwd) => commandExec("git", gitStoreArgs(gitDir, args), cwd);
	const storeExec: ExecFn = (command, args, options) =>
		exec(command, command === "git" ? gitStoreArgs(gitDir, args) : args, options);
	return { root, layout, gitDir, git, exec: storeExec, githubRepository: resolveGithubRepository(git, root) };
}
