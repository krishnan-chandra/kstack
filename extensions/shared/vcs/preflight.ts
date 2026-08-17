import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import type { VcsResult } from "./backend.ts";
import type { VcsBackendId } from "./config.ts";

const MIN_JJ_MAJOR = 0;
const MIN_JJ_MINOR = 44;
const MIN_GRAPHITE: readonly [number, number, number] = [1, 8, 5];
const MIN_GIT: readonly [number, number, number] = [2, 38, 0];

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
	if (backend === "jj") return preflightJj(cwd, exec, deps);
	return preflightGraphite(cwd, exec, deps);
}

async function preflightGraphite(
	cwd: string,
	exec: ExecFn,
	deps: PreflightDeps,
): Promise<VcsResult<{ workspaceRoot: string }>> {
	try {
		const graphite = await exec("gt", ["--version"], { cwd, timeout: 8_000 });
		const graphiteVersion = parseSemver(graphite.stdout);
		if (graphite.code !== 0 || !graphiteVersion || compareSemver(graphiteVersion, MIN_GRAPHITE) < 0) {
			return {
				ok: false,
				error: `The graphite backend requires gt >= ${MIN_GRAPHITE.join(".")}. Install or upgrade Graphite, then run gt init --trunk <branch>.`,
			};
		}
		const gitVersion = await exec("git", ["--version"], { cwd, timeout: 8_000 });
		const parsedGit = parseSemver(gitVersion.stdout);
		if (gitVersion.code !== 0 || !parsedGit || compareSemver(parsedGit, MIN_GIT) < 0) {
			return { ok: false, error: `The graphite backend requires Git >= ${MIN_GIT.join(".")}.` };
		}
		const root = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 8_000 });
		const workspaceRoot = root.stdout.trim();
		if (root.code !== 0 || !workspaceRoot)
			return { ok: false, error: "The graphite backend requires a Git working tree." };
		if ((deps.exists ?? existsSync)(join(workspaceRoot, ".jj"))) {
			return {
				ok: false,
				error: "The graphite backend cannot run in a colocated jj repository. Select the jj backend instead.",
			};
		}
		const trunk = await exec("gt", ["--no-interactive", "trunk"], { cwd: workspaceRoot, timeout: 8_000 });
		const ref = trunk.stdout.trim();
		if (trunk.code !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) {
			return {
				ok: false,
				error: "Graphite is not initialized for this repository. Run gt init --trunk <branch> and retry.",
			};
		}
		const sha = await exec("git", ["rev-parse", "--verify", `refs/heads/${ref}^{commit}`], {
			cwd: workspaceRoot,
			timeout: 8_000,
		});
		if (sha.code !== 0 || !/^[0-9a-f]{40}$/.test(sha.stdout.trim())) {
			return {
				ok: false,
				error: `Graphite trunk ${ref} is not a resolvable local branch. Run gt init --trunk <branch> and retry.`,
			};
		}
		return { ok: true, workspaceRoot };
	} catch (error) {
		return {
			ok: false,
			error: `The graphite backend preflight failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Parse the first stable x.y.z version token from a CLI response. */
export function parseSemver(text: string): [number, number, number] | null {
	const match = text.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < 3; index++) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
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
				"This repository is jj-managed but kstack.json selects the git backend. Run /skill:setup-kstack to switch the backend to jj, or remove the jj workspace.",
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

	try {
		const workspace = await exec("jj", ["workspace", "root"], { cwd, timeout: 8_000 });
		const workspaceRoot = workspace.stdout.trim();
		if (workspace.code !== 0 || !workspaceRoot) {
			return { ok: false, error: `${cwd} is not a Jujutsu workspace (jj workspace root failed).` };
		}
		const git = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 8_000 });
		const gitRoot = git.stdout.trim();
		if (git.code !== 0 || !gitRoot) {
			return {
				ok: false,
				error: "The jj backend requires a colocated Git worktree; this directory is not inside one.",
			};
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
	} catch (error) {
		return {
			ok: false,
			error: `The jj backend preflight command failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
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
