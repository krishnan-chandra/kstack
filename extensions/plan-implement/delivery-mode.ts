/** Stack-mode preflight: jj/Git colocated workspace and immutable trunk() resolution. */

import { realpathSync } from "node:fs";

const SHA_RE = /^[0-9a-f]{40}$/;
const TRUNK_TEMPLATE = 'commit_id ++ "\\n"';
const MIN_JJ_MAJOR = 0;
const MIN_JJ_MINOR = 44;

export interface ExecFnResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Injected command runner so the preflight is unit-testable without real jj/git. */
export type ExecFn = (command: string, args: string[], options: { cwd: string; timeout?: number }) => Promise<ExecFnResult>;

export interface StackPreflight {
	ok: true;
	/** Immutable Git SHA trunk() resolved to; used as the panel-review --base. */
	trunkSha: string;
	/** Jujutsu workspace root, for diagnostics. */
	workspaceRoot: string;
}

export interface PreflightError {
	ok: false;
	error: string;
}

/**
 * Verify stack-mode prerequisites and resolve the immutable trunk() Git SHA.
 * Stops before any model call when:
 *  - jj is unavailable or not a Jujutsu workspace;
 *  - the directory is not a colocated Git worktree;
 *  - trunk() does not resolve to exactly one Git-backed commit.
 */
export async function preflightStack(
	cwd: string,
	jj: ExecFn,
	git: ExecFn,
): Promise<StackPreflight | PreflightError> {
	const timeout = 8000;

	// jj present and new enough?
	let version: ExecFnResult;
	try {
		version = await jj("jj", ["--version"], { cwd, timeout });
	} catch (error) {
		return { ok: false, error: `Stack mode requires jj; it was not found (${(error as Error).message}).` };
	}
	if (version.code !== 0) {
		return { ok: false, error: `Stack mode requires jj; "jj --version" failed: ${version.stderr.trim()}` };
	}
	const parsedVersion = parseJjVersion(version.stdout);
	if (!parsedVersion) {
		return { ok: false, error: `Could not parse jj version from: ${version.stdout.trim()}` };
	}
	if (parsedVersion < [MIN_JJ_MAJOR, MIN_JJ_MINOR]) {
		return {
			ok: false,
			error: `Stack mode requires jj >= ${MIN_JJ_MAJOR}.${MIN_JJ_MINOR}; found ${parsedVersion[0]}.${parsedVersion[1]}.`,
		};
	}

	// jj workspace?
	const workspace = await jj("jj", ["workspace", "root"], { cwd, timeout });
	if (workspace.code !== 0) {
		return { ok: false, error: `${cwd} is not a Jujutsu workspace (jj workspace root failed).` };
	}
	const workspaceRoot = workspace.stdout.trim();

	// colocated Git worktree, sharing the same root as the jj workspace?
	const gitTop = await git("git", ["rev-parse", "--show-toplevel"], { cwd, timeout });
	if (gitTop.code !== 0) {
		return { ok: false, error: "Stack mode requires a colocated Git worktree; this directory is not inside one." };
	}
	const gitRoot = gitTop.stdout.trim();
	if (!sameRealPath(workspaceRoot, gitRoot)) {
		return {
			ok: false,
			error: `Stack mode requires a colocated jj/Git workspace, but the jj workspace root (${workspaceRoot}) and the Git worktree (${gitRoot}) differ. A jj workspace nested inside an unrelated Git repository is not supported.`,
		};
	}

	// trunk() resolves to exactly one commit?
	const trunkLog = await jj(
		"jj",
		["log", "-r", "trunk()", "--no-graph", "--no-pager", "-T", TRUNK_TEMPLATE],
		{ cwd, timeout },
	);
	if (trunkLog.code !== 0) {
		return {
			ok: false,
			error: `Could not resolve the trunk() revset. Ensure a remote main/master/trunk branch exists. jj said: ${trunkLog.stderr.trim() || trunkLog.stdout.trim()}`,
		};
	}
	const ids = trunkLog.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	if (ids.length === 0) {
		return { ok: false, error: "trunk() resolved to no commits; ensure a remote main/master/trunk branch." };
	}
	if (ids.length > 1) {
		return { ok: false, error: `trunk() resolved to ${ids.length} commits; a single immutable base is required.` };
	}
	const trunkSha = ids[0];
	if (!SHA_RE.test(trunkSha)) {
		return { ok: false, error: `trunk() resolved to a non-Git commit id "${trunkSha}"; a colocated Git-backed commit is required.` };
	}
	return { ok: true, trunkSha, workspaceRoot };
}

/** Parse "jj 0.44.0" (or similar) into a comparable [major, minor] tuple. */
function parseJjVersion(text: string): [number, number] | null {
	for (const token of text.trim().split(/\s+/)) {
		const parts = token.split(".");
		if (parts.length >= 2 && parts[0].match(/^\d+$/) && parts[1].match(/^\d+$/)) {
			return [Number(parts[0]), Number(parts[1])];
		}
	}
	return null;
}

/** True when both paths resolve to the same real directory. */
function sameRealPath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return a === b;
	}
}
