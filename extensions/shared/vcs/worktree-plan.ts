import type { BoundaryValue } from "../validation.ts";
/** Shared read-only planner for kstack-managed Git worktrees. */

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import { extractSlug, MAX_SLUG_LENGTH, normalizePathSegment } from "../slug.ts";
import type { IsolationPlan, VcsResult } from "./backend.ts";

const MAX_COLLISION_ATTEMPTS = 100;
const SHA_RE = /^[0-9a-f]{40}$/;
const DEFAULT_TIMEOUT = 10_000;

export interface IsolationBase {
	ref: string;
	sha: string;
}

export interface ManagedWorktreePlan {
	plan: IsolationPlan;
	managedRoot: string;
	commonGitDir: string;
	repositoryId: string;
	slug: string;
}

interface PlanManagedWorktreeOptions {
	exec: ExecFn;
	cwd: string;
	task: string;
	managedRoot?: string;
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
}

function failure(error: BoundaryValue): ExecFnResult {
	return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

function output(result: ExecFnResult): string {
	return result.stdout.trim();
}

function oneLine(result: ExecFnResult): string | undefined {
	if (result.code !== 0) return undefined;
	return output(result) || undefined;
}

async function git(exec: ExecFn, cwd: string, args: string[], timeout = DEFAULT_TIMEOUT): Promise<ExecFnResult> {
	try {
		return await exec("git", args, { cwd, timeout });
	} catch (error) {
		return failure(error);
	}
}

export async function resolveIsolationBase(exec: ExecFn, repoRoot: string): Promise<IsolationBase | undefined> {
	const remoteOutput = oneLine(await git(exec, repoRoot, ["remote"]));
	const remotes = (
		remoteOutput
			?.split(/\r?\n/)
			.map((remote) => remote.trim())
			.filter(Boolean) ?? []
	).sort();
	if (remotes.includes("origin")) {
		remotes.splice(remotes.indexOf("origin"), 1);
		remotes.unshift("origin");
	}
	const remoteHeads: string[] = [];
	for (const remote of remotes) {
		const head = oneLine(await git(exec, repoRoot, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]));
		if (head) remoteHeads.push(head);
	}
	if (remoteHeads.length === 0) {
		const originHead = oneLine(await git(exec, repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]));
		if (originHead) remoteHeads.push(originHead);
	}
	const conventional = remotes.flatMap((remote) => [`refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]);
	const candidates = [
		...remoteHeads,
		...conventional,
		"refs/remotes/origin/main",
		"refs/remotes/origin/master",
		"refs/heads/main",
		"refs/heads/master",
		"HEAD",
	];
	for (const ref of [...new Set(candidates)]) {
		const sha = oneLine(await git(exec, repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]));
		if (SHA_RE.test(sha ?? "")) return { ref, sha: sha! };
	}
	return undefined;
}

export async function planManagedWorktree(
	options: PlanManagedWorktreeOptions,
): Promise<VcsResult<ManagedWorktreePlan>> {
	const { exec, cwd, task } = options;
	const rootResult = await git(exec, cwd, ["rev-parse", "--show-toplevel"], 8_000);
	const sourceRepoRoot = oneLine(rootResult);
	if (!sourceRepoRoot) return { ok: false, error: "Worktree mode requires a Git working tree." };

	const commonResult = await git(exec, sourceRepoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const commonRaw = oneLine(commonResult);
	if (!commonRaw) {
		return {
			ok: false,
			error: `Could not resolve the repository's common Git directory: ${commonResult.stderr.trim()}`,
		};
	}

	const realpath = options.realpath ?? realpathSync;
	let commonGitDir: string;
	try {
		commonGitDir = realpath(resolve(sourceRepoRoot, commonRaw));
	} catch (error) {
		return { ok: false, error: `Could not canonicalize the common Git directory: ${failure(error).stderr}` };
	}

	const base = await resolveIsolationBase(exec, sourceRepoRoot);
	if (!base) {
		return {
			ok: false,
			error:
				"Could not resolve a worktree base. Configure origin/HEAD, main, or master, or ensure HEAD names a commit.",
		};
	}

	const managedRoot = resolve(options.managedRoot ?? join(homedir(), ".pi", "kstack", "worktrees"));
	const repositoryName = normalizePathSegment(basename(sourceRepoRoot));
	const repositoryHash = createHash("sha256").update(commonGitDir).digest("hex").slice(0, 8);
	const repositoryId = `${repositoryName}-${repositoryHash}`;
	const baseSlug = extractSlug(task);
	const pathExists = options.exists ?? existsSync;
	for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
		const suffix = attempt === 1 ? "" : `-${attempt}`;
		const slug = `${baseSlug.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
		const ref = `kstack/${slug}`;
		const path = join(managedRoot, repositoryId, slug);
		const branchLookup = await git(exec, sourceRepoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
		if (branchLookup.code !== 0 && !pathExists(path)) {
			return {
				ok: true,
				plan: {
					sourceRepoRoot,
					ref,
					path,
					baseRef: base.ref,
					baseSha: base.sha,
				},
				managedRoot,
				commonGitDir,
				repositoryId,
				slug,
			};
		}
	}
	return {
		ok: false,
		error: `Could not allocate a unique managed worktree after ${MAX_COLLISION_ATTEMPTS} attempts.`,
	};
}
