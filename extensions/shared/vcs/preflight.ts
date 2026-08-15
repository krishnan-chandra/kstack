import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import type { VcsResult } from "./backend.ts";
import type { VcsBackendId } from "./config.ts";

const MIN_JJ_MAJOR = 0;
const MIN_JJ_MINOR = 44;

interface PreflightDeps {
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
}

/** Enforce that mutation uses the configured backend before any model runs. */
export async function preflightVcs(
	cwd: string,
	backend: VcsBackendId,
	exec: ExecFn,
	deps: PreflightDeps = {},
): Promise<VcsResult<{ workspaceRoot: string }>> {
	if (backend === "git") return preflightGit(cwd, exec, deps);
	return preflightJj(cwd, exec, deps);
}

async function preflightGit(
	cwd: string,
	exec: ExecFn,
	deps: PreflightDeps,
): Promise<VcsResult<{ workspaceRoot: string }>> {
	let root: ExecFnResult;
	try {
		root = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 8_000 });
	} catch (error) {
		return {
			ok: false,
			error: `The git backend requires Git, but the preflight command failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const workspaceRoot = root.stdout.trim();
	if (root.code !== 0 || !workspaceRoot) {
		return { ok: false, error: "The git backend requires a Git working tree." };
	}
	if ((deps.exists ?? existsSync)(join(workspaceRoot, ".jj"))) {
		return {
			ok: false,
			error:
				"This repository is jj-managed but kstack.json selects the git backend. Run /setup-kstack to switch the backend to jj, or remove the jj workspace.",
		};
	}
	return { ok: true, workspaceRoot };
}

async function preflightJj(
	cwd: string,
	exec: ExecFn,
	deps: PreflightDeps,
): Promise<VcsResult<{ workspaceRoot: string }>> {
	let version: ExecFnResult;
	try {
		version = await exec("jj", ["--version"], { cwd, timeout: 8_000 });
	} catch (error) {
		return {
			ok: false,
			error: `The jj backend requires jj >= ${MIN_JJ_MAJOR}.${MIN_JJ_MINOR}, but jj was not found: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (version.code !== 0) {
		return { ok: false, error: `The jj backend requires jj, but "jj --version" failed: ${diagnostic(version)}` };
	}
	const parsed = parseJjVersion(version.stdout);
	if (!parsed) return { ok: false, error: `Could not parse jj version from: ${version.stdout.trim()}` };
	if (parsed[0] < MIN_JJ_MAJOR || (parsed[0] === MIN_JJ_MAJOR && parsed[1] < MIN_JJ_MINOR)) {
		return {
			ok: false,
			error: `The jj backend requires jj >= ${MIN_JJ_MAJOR}.${MIN_JJ_MINOR}; found ${parsed[0]}.${parsed[1]}.`,
		};
	}

	const workspace = await exec("jj", ["workspace", "root"], { cwd, timeout: 8_000 });
	const workspaceRoot = workspace.stdout.trim();
	if (workspace.code !== 0 || !workspaceRoot) {
		return { ok: false, error: `${cwd} is not a Jujutsu workspace (jj workspace root failed).` };
	}
	const git = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 8_000 });
	const gitRoot = git.stdout.trim();
	if (git.code !== 0 || !gitRoot) {
		return { ok: false, error: "The jj backend requires a colocated Git worktree; this directory is not inside one." };
	}
	if (!sameRealPath(workspaceRoot, gitRoot, deps.realpath)) {
		return {
			ok: false,
			error: `The jj workspace root (${workspaceRoot}) and Git worktree (${gitRoot}) differ. K-Stack requires a colocated jj/Git workspace.`,
		};
	}

	for (const key of ["user.name", "user.email"] as const) {
		const configured = await exec("jj", ["config", "get", key], { cwd: workspaceRoot, timeout: 8_000 });
		if (configured.code !== 0 || !configured.stdout.trim()) {
			return {
				ok: false,
				error: `The jj backend requires ${key}. Configure it with: jj config set --user ${key} ${key === "user.name" ? '"Your Name"' : '"you@example.com"'}`,
			};
		}
	}
	return { ok: true, workspaceRoot };
}

/** Parse "jj 0.44.0" (or similar) into a comparable [major, minor] tuple. */
export function parseJjVersion(text: string): [number, number] | null {
	for (const token of text.trim().split(/\s+/)) {
		const parts = token.split(".");
		if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
			return [Number(parts[0]), Number(parts[1])];
		}
	}
	return null;
}

function sameRealPath(a: string, b: string, realpath?: (path: string) => string): boolean {
	const resolvePath: (path: string) => string = realpath ?? realpathSync;
	try {
		return resolvePath(a) === resolvePath(b);
	} catch {
		return a === b;
	}
}

function diagnostic(result: ExecFnResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}
