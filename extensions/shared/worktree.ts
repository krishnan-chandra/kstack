/** Deterministic planning and creation of managed Git worktrees. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExecFn, ExecFnResult } from "./git-exec.ts";
import { extractSlug, MAX_SLUG_LENGTH, normalizePathSegment } from "./slug.ts";

const MAX_COLLISION_ATTEMPTS = 100;

export interface ManagedWorktreePlan {
	sourceRepoRoot: string;
	commonGitDir: string;
	managedRoot: string;
	repositoryId: string;
	slug: string;
	branch: string;
	path: string;
	baseRef: string;
	baseSha: string;
}

type WorktreePlanResult = { ok: true; plan: ManagedWorktreePlan } | { ok: false; error: string };
type WorktreeCreateResult = { ok: true; plan: ManagedWorktreePlan } | { ok: false; error: string };

interface WorktreeDeps {
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	mkdir?: (path: string) => void;
	managedRoot?: string;
}

function failResult(stderr: string, code = 1): ExecFnResult {
	return { code, stdout: "", stderr };
}

async function runGit(exec: ExecFn, args: string[], cwd: string): Promise<ExecFnResult> {
	try {
		return await exec("git", args, { cwd, timeout: 10_000 });
	} catch (error) {
		return failResult((error as Error).message);
	}
}

function oneLine(result: ExecFnResult): string | undefined {
	if (result.code !== 0) return undefined;
	const value = result.stdout.trim();
	return value || undefined;
}

function managedWorktreeRoot(): string {
	return join(homedir(), ".pi", "kstack", "worktrees");
}

async function resolveBase(exec: ExecFn, repoRoot: string): Promise<{ ref: string; sha: string } | undefined> {
	const remoteOutput = oneLine(await runGit(exec, ["remote"], repoRoot));
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
		const head = oneLine(await runGit(exec, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], repoRoot));
		if (head) remoteHeads.push(head);
	}
	// Keep origin/HEAD as the first probe even when `git remote` is unavailable
	// to preserve useful diagnostics and compatibility with minimal Git fakes.
	if (!remoteHeads.length) {
		const originHead = oneLine(await runGit(exec, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoRoot));
		if (originHead) remoteHeads.push(originHead);
	}
	const conventionalRemoteRefs = remotes.flatMap((remote) => [
		`refs/remotes/${remote}/main`,
		`refs/remotes/${remote}/master`,
	]);
	const candidates = [
		...remoteHeads,
		...conventionalRemoteRefs,
		"refs/remotes/origin/main",
		"refs/remotes/origin/master",
		"refs/heads/main",
		"refs/heads/master",
		"HEAD",
	].filter((value): value is string => Boolean(value));
	for (const ref of [...new Set(candidates)]) {
		const sha = oneLine(await runGit(exec, ["rev-parse", "--verify", `${ref}^{commit}`], repoRoot));
		if (/^[0-9a-f]{40}$/.test(sha ?? "")) return { ref, sha: sha! };
	}
	return undefined;
}

/** Resolve a unique managed path and branch without mutating the repository. */
export async function planManagedWorktree(
	cwd: string,
	task: string,
	exec: ExecFn,
	deps: WorktreeDeps = {},
): Promise<WorktreePlanResult> {
	const repoRootResult = await runGit(exec, ["rev-parse", "--show-toplevel"], cwd);
	const sourceRepoRoot = oneLine(repoRootResult);
	if (!sourceRepoRoot) return { ok: false, error: "Worktree mode requires a Git working tree." };

	const commonResult = await runGit(exec, ["rev-parse", "--path-format=absolute", "--git-common-dir"], sourceRepoRoot);
	const commonRaw = oneLine(commonResult);
	if (!commonRaw)
		return {
			ok: false,
			error: `Could not resolve the repository's common Git directory: ${commonResult.stderr.trim()}`,
		};

	const realpath = deps.realpath ?? realpathSync;
	let commonGitDir: string;
	try {
		commonGitDir = realpath(resolve(sourceRepoRoot, commonRaw));
	} catch (error) {
		return { ok: false, error: `Could not canonicalize the common Git directory: ${(error as Error).message}` };
	}

	const base = await resolveBase(exec, sourceRepoRoot);
	if (!base) {
		return {
			ok: false,
			error:
				"Could not resolve a worktree base. Configure origin/HEAD, main, or master, or ensure HEAD names a commit.",
		};
	}

	const managedRoot = resolve(deps.managedRoot ?? managedWorktreeRoot());
	const repositoryName = normalizePathSegment(basename(sourceRepoRoot));
	const repositoryHash = createHash("sha256").update(commonGitDir).digest("hex").slice(0, 8);
	const repositoryId = `${repositoryName}-${repositoryHash}`;
	const baseSlug = extractSlug(task);
	const exists = deps.exists ?? existsSync;

	for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
		const suffix = attempt === 1 ? "" : `-${attempt}`;
		const slug = `${baseSlug.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
		const branch = `kstack/${slug}`;
		const path = join(managedRoot, repositoryId, slug);
		const branchLookup = await runGit(
			exec,
			["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
			sourceRepoRoot,
		);
		if (branchLookup.code !== 0 && !exists(path)) {
			return {
				ok: true,
				plan: {
					sourceRepoRoot,
					commonGitDir,
					managedRoot,
					repositoryId,
					slug,
					branch,
					path,
					baseRef: base.ref,
					baseSha: base.sha,
				},
			};
		}
	}
	return { ok: false, error: `Could not allocate a unique managed worktree after ${MAX_COLLISION_ATTEMPTS} attempts.` };
}

/** Create the previously planned linked worktree. Revalidates collisions first. */
export async function createManagedWorktree(
	plan: ManagedWorktreePlan,
	exec: ExecFn,
	deps: WorktreeDeps = {},
): Promise<WorktreeCreateResult> {
	const branchLookup = await runGit(
		exec,
		["show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`],
		plan.sourceRepoRoot,
	);
	const exists = deps.exists ?? existsSync;
	if (branchLookup.code === 0 || exists(plan.path)) {
		return {
			ok: false,
			error: `Worktree destination or branch appeared after preflight: ${plan.path} (${plan.branch}). Nothing was overwritten.`,
		};
	}

	try {
		(deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true })))(join(plan.managedRoot, plan.repositoryId));
	} catch (error) {
		return { ok: false, error: `Could not create the managed worktree directory: ${(error as Error).message}` };
	}

	const added = await runGit(
		exec,
		["worktree", "add", "--no-guess-remote", "-b", plan.branch, plan.path, plan.baseSha],
		plan.sourceRepoRoot,
	);
	if (added.code !== 0) {
		return {
			ok: false,
			error: `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}. The managed directory and branch may need manual inspection.`,
		};
	}
	const verified = await runGit(exec, ["rev-parse", "--show-toplevel"], plan.path);
	const verifiedRoot = oneLine(verified);
	const realpath = deps.realpath ?? realpathSync;
	try {
		if (!verifiedRoot || realpath(verifiedRoot) !== realpath(plan.path)) {
			return {
				ok: false,
				error: `Git created the worktree but verification returned an unexpected root: ${verifiedRoot ?? "none"}.`,
			};
		}
	} catch (error) {
		return {
			ok: false,
			error: `Git created the worktree but its path could not be verified: ${(error as Error).message}.`,
		};
	}
	return { ok: true, plan };
}
