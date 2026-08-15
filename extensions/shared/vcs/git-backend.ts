/** Git implementation of K-Stack's repository-mutation contract. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import { extractSlug, MAX_SLUG_LENGTH, normalizePathSegment } from "../slug.ts";
import type {
	CurrentRef,
	IsolationPlan,
	MergeBaseResult,
	VcsBackend,
	VcsResult,
	WorkstreamCheckpoint,
} from "./backend.ts";
import { preflightVcs } from "./preflight.ts";

const MAX_COLLISION_ATTEMPTS = 100;
const SHA_RE = /^[0-9a-f]{40}$/;

interface GitBackendDeps {
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	mkdir?: (path: string) => void;
	managedRoot?: string;
}

function failure(error: unknown): ExecFnResult {
	return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

function output(result: ExecFnResult): string {
	return result.stdout.trim();
}

function oneLine(result: ExecFnResult): string | undefined {
	if (result.code !== 0) return undefined;
	return output(result) || undefined;
}

function parsePorcelainPaths(stdout: string): string[] {
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length < 4) continue;
		const value = line.slice(3);
		const arrow = value.indexOf(" -> ");
		const path = (arrow === -1 ? value : value.slice(arrow + 4)).trim();
		if (path) paths.push(path);
	}
	return paths;
}

export class GitBackend implements VcsBackend {
	readonly id = "git" as const;
	private readonly exec: ExecFn;
	private readonly deps: GitBackendDeps;

	constructor(exec: ExecFn, deps: GitBackendDeps = {}) {
		this.exec = exec;
		this.deps = deps;
	}

	private async git(cwd: string, args: string[], timeout = 10_000): Promise<ExecFnResult> {
		try {
			return await this.exec("git", args, { cwd, timeout });
		} catch (error) {
			return failure(error);
		}
	}

	preflight(cwd: string): Promise<VcsResult<{ workspaceRoot: string }>> {
		return preflightVcs(cwd, this.id, this.exec, { exists: this.deps.exists });
	}

	async workspaceRoot(cwd: string): Promise<VcsResult<{ path: string }>> {
		const result = await this.git(cwd, ["rev-parse", "--show-toplevel"], 8_000);
		const path = oneLine(result);
		return path ? { ok: true, path } : { ok: false, error: "The git backend requires a Git working tree." };
	}

	async headSha(cwd: string): Promise<VcsResult<{ sha: string }>> {
		const result = await this.git(cwd, ["rev-parse", "HEAD"], 5_000);
		const sha = output(result);
		return result.code === 0 && SHA_RE.test(sha)
			? { ok: true, sha }
			: { ok: false, error: `Could not resolve the current HEAD: ${result.stderr.trim() || result.stdout.trim()}` };
	}

	async currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>> {
		const result = await this.git(cwd, ["branch", "--show-current"], 5_000);
		if (result.code !== 0) {
			return { ok: false, error: `Could not resolve the current Git branch: ${result.stderr.trim()}` };
		}
		const name = output(result);
		return { ok: true, ref: name ? { kind: "branch", name } : { kind: "detached" } };
	}

	async changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>> {
		const status = await this.git(cwd, ["status", "--porcelain"], 5_000);
		return status.code === 0
			? { ok: true, paths: parsePorcelainPaths(status.stdout) }
			: { ok: false, error: `Could not inspect working-copy changes: ${status.stderr.trim()}` };
	}

	async isWorkingCopyEmpty(cwd: string): Promise<VcsResult<{ empty: boolean; details?: string }>> {
		const status = await this.git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], 5_000);
		if (status.code !== 0) return { ok: false, error: `Could not inspect the working tree: ${status.stderr.trim()}` };
		const details = output(status);
		return details ? { ok: true, empty: false, details } : { ok: true, empty: true };
	}

	async createWorkstream(cwd: string, task: string): Promise<VcsResult<WorkstreamCheckpoint>> {
		const clean = await this.isWorkingCopyEmpty(cwd);
		if (!clean.ok) return clean;
		if (!clean.empty) {
			return {
				ok: false,
				error: `The current working tree is dirty; no task branch was created. Rerun with --worktree.\n${clean.details ?? ""}`,
			};
		}
		const base = await this.headSha(cwd);
		if (!base.ok) return base;
		const slug = extractSlug(task);
		for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
			const ref = `kstack/${slug}${attempt === 1 ? "" : `-${attempt}`}`;
			const exists = await this.git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
			if (exists.code === 0) continue;
			const created = await this.git(cwd, ["switch", "-c", ref]);
			if (created.code !== 0) {
				return {
					ok: false,
					error: `Could not create task branch ${ref}: ${created.stderr.trim() || created.stdout.trim()}`,
				};
			}
			return { ok: true, ref, baseSha: base.sha };
		}
		return { ok: false, error: `Could not allocate a unique task branch after ${MAX_COLLISION_ATTEMPTS} attempts.` };
	}

	async verifyCommittedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>> {
		const current = await this.currentRef(cwd);
		const actual = current.ok && current.ref.kind === "branch" ? current.ref.name : "detached HEAD";
		if (!current.ok || actual !== expected.ref) {
			return { ok: false, error: `Workstream postcondition failed: expected branch ${expected.ref}, found ${actual}.` };
		}
		const head = await this.headSha(cwd);
		if (!head.ok) return { ok: false, error: `Workstream postcondition failed: ${head.error}` };
		if (expected.requireNewCommit && head.sha === expected.baseSha) {
			return { ok: false, error: "Workstream postcondition failed: implementation created no commits." };
		}
		const clean = await this.isWorkingCopyEmpty(cwd);
		if (!clean.ok) return clean;
		if (!clean.empty) {
			return { ok: false, error: `Workstream postcondition failed: uncommitted files remain.\n${clean.details ?? ""}` };
		}
		return { ok: true, headSha: head.sha };
	}

	async planIsolation(cwd: string, task: string): Promise<VcsResult<{ plan: IsolationPlan }>> {
		const root = await this.workspaceRoot(cwd);
		if (!root.ok) return { ok: false, error: "Worktree mode requires a Git working tree." };
		const sourceRepoRoot = root.path;
		const commonResult = await this.git(sourceRepoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const commonRaw = oneLine(commonResult);
		if (!commonRaw) {
			return {
				ok: false,
				error: `Could not resolve the repository's common Git directory: ${commonResult.stderr.trim()}`,
			};
		}
		const realpath = this.deps.realpath ?? realpathSync;
		let commonGitDir: string;
		try {
			commonGitDir = realpath(resolve(sourceRepoRoot, commonRaw));
		} catch (error) {
			return { ok: false, error: `Could not canonicalize the common Git directory: ${failure(error).stderr}` };
		}
		const base = await this.resolveIsolationBase(sourceRepoRoot);
		if (!base) {
			return {
				ok: false,
				error:
					"Could not resolve a worktree base. Configure origin/HEAD, main, or master, or ensure HEAD names a commit.",
			};
		}
		const managedRoot = resolve(this.deps.managedRoot ?? join(homedir(), ".pi", "kstack", "worktrees"));
		const repositoryName = normalizePathSegment(basename(sourceRepoRoot));
		const repositoryHash = createHash("sha256").update(commonGitDir).digest("hex").slice(0, 8);
		const repositoryId = `${repositoryName}-${repositoryHash}`;
		const baseSlug = extractSlug(task);
		const pathExists = this.deps.exists ?? existsSync;
		for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
			const suffix = attempt === 1 ? "" : `-${attempt}`;
			const slug = `${baseSlug.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
			const ref = `kstack/${slug}`;
			const path = join(managedRoot, repositoryId, slug);
			const branchLookup = await this.git(sourceRepoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
			if (branchLookup.code !== 0 && !pathExists(path)) {
				return {
					ok: true,
					plan: {
						kind: "git-worktree",
						sourceRepoRoot,
						commonGitDir,
						managedRoot,
						repositoryId,
						slug,
						ref,
						path,
						baseRef: base.ref,
						baseSha: base.sha,
					},
				};
			}
		}
		return {
			ok: false,
			error: `Could not allocate a unique managed worktree after ${MAX_COLLISION_ATTEMPTS} attempts.`,
		};
	}

	async createIsolation(plan: IsolationPlan): Promise<VcsResult<{ plan: IsolationPlan }>> {
		if (plan.kind !== "git-worktree") return { ok: false, error: "The Git backend requires a Git worktree plan." };
		const branchLookup = await this.git(plan.sourceRepoRoot, [
			"show-ref",
			"--verify",
			"--quiet",
			`refs/heads/${plan.ref}`,
		]);
		const pathExists = this.deps.exists ?? existsSync;
		if (branchLookup.code === 0 || pathExists(plan.path)) {
			return {
				ok: false,
				error: `Worktree destination or branch appeared after preflight: ${plan.path} (${plan.ref}). Nothing was overwritten.`,
			};
		}
		try {
			(this.deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true })))(
				join(plan.managedRoot, plan.repositoryId),
			);
		} catch (error) {
			return { ok: false, error: `Could not create the managed worktree directory: ${failure(error).stderr}` };
		}
		const added = await this.git(
			plan.sourceRepoRoot,
			["worktree", "add", "--no-guess-remote", "-b", plan.ref, plan.path, plan.baseSha],
			10_000,
		);
		if (added.code !== 0) {
			return {
				ok: false,
				error: `git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}. The managed directory and branch may need manual inspection.`,
			};
		}
		const verified = await this.git(plan.path, ["rev-parse", "--show-toplevel"]);
		const verifiedRoot = oneLine(verified);
		const realpath = this.deps.realpath ?? realpathSync;
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
				error: `Git created the worktree but its path could not be verified: ${failure(error).stderr}.`,
			};
		}
		return { ok: true, plan };
	}

	async removeIsolation(cwd: string, ref: string): Promise<VcsResult<{ warning?: string }>> {
		const common = await this.git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5_000);
		const commonDir = output(common);
		if (common.code !== 0 || !commonDir) {
			return { ok: false, error: `Could not locate the owning repository: ${common.stderr.trim()}` };
		}
		const ownerRoot = join(commonDir, "..");
		const remove = await this.git(ownerRoot, ["worktree", "remove", cwd, "--force"], 15_000);
		if (remove.code !== 0) {
			return {
				ok: false,
				error: `Worktree removal failed: ${remove.stderr.trim()}. You may need to remove it manually.`,
			};
		}
		const deleted = await this.git(ownerRoot, ["branch", "-d", ref], 5_000);
		return deleted.code === 0
			? { ok: true }
			: { ok: true, warning: `Branch deletion warning: ${deleted.stderr.trim()}` };
	}

	async commitPaths(cwd: string, paths: string[], message: string): Promise<VcsResult> {
		const add = await this.git(cwd, ["add", "--", ...paths]);
		if (add.code !== 0) return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
		const commit = await this.git(cwd, ["commit", "-m", message]);
		return commit.code === 0 ? { ok: true } : { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
	}

	async restorePaths(cwd: string, paths: string[]): Promise<VcsResult> {
		const errors: string[] = [];
		for (const path of paths) {
			const restore = await this.git(cwd, ["restore", "--staged", "--worktree", "--", path]);
			if (restore.code === 0) continue;
			const clean = await this.git(cwd, ["clean", "-f", "--", path]);
			if (clean.code !== 0) errors.push(`${path}: ${restore.stderr.trim() || clean.stderr.trim()}`);
		}
		return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join("; ") };
	}

	async push(cwd: string, ref: string): Promise<VcsResult> {
		const result = await this.git(cwd, ["push", "origin", `HEAD:${ref}`], 30_000);
		return result.code === 0 ? { ok: true } : { ok: false, error: `git push failed: ${result.stderr.trim()}` };
	}

	async fetch(cwd: string, ref?: string): Promise<VcsResult> {
		const result = await this.git(cwd, ["fetch", "origin", ...(ref ? [ref] : [])], 60_000);
		return result.code === 0
			? { ok: true }
			: { ok: false, error: `git fetch origin${ref ? ` ${ref}` : ""} failed: ${result.stderr.trim()}` };
	}

	async integrateRemoteHead(cwd: string, ref: string): Promise<VcsResult> {
		const fetched = await this.fetch(cwd, ref);
		if (!fetched.ok) return fetched;
		const ff = await this.git(cwd, ["merge", "--ff-only", `origin/${ref}`], 15_000);
		if (ff.code === 0) return { ok: true };
		const merge = await this.git(cwd, ["merge", "--no-edit", `origin/${ref}`], 30_000);
		if (merge.code === 0) return { ok: true };
		await this.git(cwd, ["merge", "--abort"]);
		return { ok: false, error: `Could not integrate origin/${ref} without a rebase. ${merge.stderr.trim()}` };
	}

	async mergeBaseIntoHead(cwd: string, baseRef: string): Promise<MergeBaseResult> {
		const fetched = await this.fetch(cwd, baseRef);
		if (!fetched.ok) return { kind: "failed", error: fetched.error };
		const merge = await this.git(cwd, ["merge", "--no-edit", `origin/${baseRef}`], 30_000);
		if (merge.code === 0) {
			if (/Already up to date/i.test(merge.stdout)) return { kind: "already-current" };
			const head = await this.headSha(cwd);
			return head.ok
				? { kind: "clean", headSha: head.sha }
				: { kind: "failed", error: "merge succeeded but HEAD SHA could not be read." };
		}
		const unmerged = await this.git(cwd, ["diff", "--name-only", "--diff-filter=U"], 5_000);
		const files = unmerged.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		await this.git(cwd, ["merge", "--abort"]);
		return {
			kind: "needs-human",
			files,
			error:
				files.length > 0
					? `Merge of origin/${baseRef} conflicted in ${files.join(", ")}. Competing intents need a human.`
					: `git merge origin/${baseRef} failed: ${merge.stderr.trim() || merge.stdout.trim()}`,
		};
	}

	private async resolveIsolationBase(repoRoot: string): Promise<{ ref: string; sha: string } | undefined> {
		const remoteOutput = oneLine(await this.git(repoRoot, ["remote"]));
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
			const head = oneLine(await this.git(repoRoot, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]));
			if (head) remoteHeads.push(head);
		}
		if (remoteHeads.length === 0) {
			const originHead = oneLine(await this.git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]));
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
			const sha = oneLine(await this.git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]));
			if (SHA_RE.test(sha ?? "")) return { ref, sha: sha! };
		}
		return undefined;
	}
}

export function createGitBackend(exec: ExecFn): VcsBackend {
	return new GitBackend(exec);
}
