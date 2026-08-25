import type { BoundaryValue } from "../validation.ts";
/** Git implementation of K-Stack's repository-mutation contract. */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import { extractSlug } from "../slug.ts";
import type {
	CurrentRef,
	GitVcsBackend,
	IsolationPlan,
	MergeBaseResult,
	VcsResult,
	WorkstreamCheckpoint,
	WorkstreamSnapshot,
} from "./backend.ts";
import { preflightVcs } from "./preflight.ts";
import { planManagedWorktree } from "./worktree-plan.ts";

const MAX_COLLISION_ATTEMPTS = 100;
const SHA_RE = /^[0-9a-f]{40}$/;

interface GitBackendDeps {
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	mkdir?: (path: string) => void;
	managedRoot?: string;
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

interface WorktreeRecord {
	path: string;
	branch?: string;
	locked: boolean;
}

function parseWorktreeRecords(stdout: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let current: WorktreeRecord | undefined;
	for (const field of stdout.split("\0")) {
		if (field.startsWith("worktree ")) {
			if (current) records.push(current);
			current = { path: field.slice("worktree ".length), locked: false };
		} else if (current && field.startsWith("branch refs/heads/")) {
			current.branch = field.slice("branch refs/heads/".length);
		} else if (current && (field === "locked" || field.startsWith("locked "))) {
			current.locked = true;
		}
	}
	if (current) records.push(current);
	return records;
}

function isContained(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix);
}

/* exported: shared Git and Graphite managed-worktree cleanup preflight */
export async function removeManagedGitWorktree(input: {
	cwd: string;
	ref: string;
	managedRoot?: string;
	realpath?: (path: string) => string;
	git(cwd: string, args: string[], timeout?: number): Promise<ExecFnResult>;
}): Promise<VcsResult<{ ownerRoot: string }>> {
	const realpath = input.realpath ?? realpathSync;
	let canonicalCwd: string;
	let managedRoot: string;
	try {
		canonicalCwd = realpath(input.cwd);
		managedRoot = realpath(resolve(input.managedRoot ?? join(homedir(), ".pi", "kstack", "worktrees")));
	} catch (error) {
		return { ok: false, error: `Could not verify the managed worktree path: ${failure(error).stderr}` };
	}
	if (!isContained(managedRoot, canonicalCwd)) {
		return { ok: false, error: `Refusing to remove a worktree outside the managed root ${managedRoot}.` };
	}
	const common = await input.git(canonicalCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5_000);
	const commonDir = output(common);
	if (common.code !== 0 || !commonDir) {
		return { ok: false, error: `Could not locate the owning repository: ${common.stderr.trim()}` };
	}
	const ownerRoot = join(commonDir, "..");
	const listed = await input.git(ownerRoot, ["worktree", "list", "--porcelain", "-z"], 5_000);
	if (listed.code !== 0) return { ok: false, error: `Could not inspect Git worktrees: ${listed.stderr.trim()}` };
	const record = parseWorktreeRecords(listed.stdout).find((item) => {
		try {
			return realpath(item.path) === canonicalCwd;
		} catch {
			return false;
		}
	});
	if (!record) return { ok: false, error: `Git does not list ${canonicalCwd} as an authoritative worktree.` };
	if (record.branch !== input.ref) {
		return {
			ok: false,
			error: `Worktree branch changed: expected ${input.ref}, found ${record.branch ?? "detached HEAD"}.`,
		};
	}
	if (record.locked) return { ok: false, error: `Worktree ${canonicalCwd} is locked; unlock it before cleanup.` };
	const status = await input.git(canonicalCwd, ["status", "--porcelain=v1", "--untracked-files=all"], 5_000);
	if (status.code !== 0) return { ok: false, error: `Could not inspect the working tree: ${status.stderr.trim()}` };
	if (output(status)) {
		return { ok: false, error: `Worktree ${canonicalCwd} has uncommitted or untracked files; cleanup preserved it.` };
	}
	const removed = await input.git(ownerRoot, ["worktree", "remove", canonicalCwd], 15_000);
	if (removed.code !== 0) {
		return {
			ok: false,
			error: `Worktree removal failed: ${removed.stderr.trim()}. You may need to remove it manually.`,
		};
	}
	return { ok: true, ownerRoot };
}

function parsePorcelainPaths(stdout: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const fields = stdout.split("\0");

	let i = 0;
	while (i < fields.length) {
		const field = fields[i];
		if (field.length < 4) {
			i++;
			continue;
		}

		const xy = field.slice(0, 2);
		const path = field.slice(3); // skip "XY<space>"
		if (!path) {
			i++;
			continue;
		}

		// Rename/copy: destination first, source follows in next NUL field
		if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
			if (!seen.has(path)) {
				seen.add(path);
				paths.push(path); // destination
			}
			i++;
			if (i < fields.length) {
				const source = fields[i];
				if (source && !seen.has(source)) {
					seen.add(source);
					paths.push(source);
				}
			}
			i++;
			continue;
		}

		// Ordinary entry
		if (!seen.has(path)) {
			seen.add(path);
			paths.push(path);
		}
		i++;
	}

	return paths;
}

export class GitBackend implements GitVcsBackend {
	readonly id = "git" as const;
	readonly descriptor = { refNoun: "branch", workstreamNoun: "Git checkout", baseUpdateVerb: "merge" } as const;
	readonly isolation = {
		plan: (cwd: string, task: string) => this.planIsolation(cwd, task),
		create: (plan: IsolationPlan) => this.createIsolation(plan),
		remove: (cwd: string, ref: string) => this.removeIsolation(cwd, ref),
	};
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

	childGuidance(): string {
		return [
			"VCS backend: git.",
			"Use Git for all version-control state and mutations. Do not run jj commands.",
			"Work only on the branch or worktree prepared by the parent, make incremental Git commits, and leave the working tree clean.",
		].join(" ");
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

	async captureWorkstream(cwd: string): Promise<VcsResult<{ snapshot: WorkstreamSnapshot }>> {
		const [current, head] = await Promise.all([this.currentRef(cwd), this.headSha(cwd)]);
		if (!current.ok) return current;
		if (current.ref.kind !== "branch") {
			return { ok: false, error: "The Git workstream has no current branch." };
		}
		if (!head.ok) return head;
		return { ok: true, snapshot: { ref: current.ref.name, token: `${current.ref.name}@${head.sha}` } };
	}

	/** @deprecated Use captureWorkstream. */
	async workstreamIdentity(
		cwd: string,
	): Promise<VcsResult<{ identity: { kind: "git"; ref: string; headSha: string } }>> {
		const [current, head] = await Promise.all([this.currentRef(cwd), this.headSha(cwd)]);
		if (!current.ok) return current;
		if (current.ref.kind !== "branch") return { ok: false, error: "The Git workstream has no current branch." };
		if (!head.ok) return head;
		return { ok: true, identity: { kind: "git", ref: current.ref.name, headSha: head.sha } };
	}

	async assertWorkstreamUnchanged(cwd: string, expected: WorkstreamSnapshot): Promise<VcsResult> {
		const actual = await this.captureWorkstream(cwd);
		if (!actual.ok) return actual;
		return actual.snapshot.token === expected.token
			? { ok: true }
			: { ok: false, error: `The current workstream changed (expected ${expected.ref}). Refusing to publish.` };
	}

	async changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>> {
		const status = await this.git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 5_000);
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

	async verifyRecordedWorkstream(
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
		const planned = await planManagedWorktree({
			exec: this.exec,
			cwd,
			task,
			managedRoot: this.deps.managedRoot,
			exists: this.deps.exists,
			realpath: this.deps.realpath,
		});
		return planned.ok ? { ok: true, plan: planned.plan } : planned;
	}

	async createIsolation(plan: IsolationPlan): Promise<VcsResult<{ plan: IsolationPlan }>> {
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
			(this.deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true })))(dirname(plan.path));
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
		const removed = await removeManagedGitWorktree({
			cwd,
			ref,
			managedRoot: this.deps.managedRoot,
			realpath: this.deps.realpath,
			git: (gitCwd, args, timeout) => this.git(gitCwd, args, timeout),
		});
		if (!removed.ok) return removed;
		const deleted = await this.git(removed.ownerRoot, ["branch", "-d", ref], 5_000);
		return deleted.code === 0
			? { ok: true }
			: { ok: true, warning: `Branch deletion warning: ${deleted.stderr.trim()}` };
	}

	async recordPaths(cwd: string, paths: string[], message: string): Promise<VcsResult> {
		const add = await this.git(cwd, ["add", "--", ...paths]);
		if (add.code !== 0) return { ok: false, error: `git add failed: ${add.stderr.trim()}` };
		const commit = await this.git(cwd, ["commit", "-m", message]);
		return commit.code === 0 ? { ok: true } : { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };
	}

	/** @deprecated Use recordPaths. */
	commitPaths(cwd: string, paths: string[], message: string): Promise<VcsResult> {
		return this.recordPaths(cwd, paths, message);
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

	async publishRecordedChanges(cwd: string, ref: string, _options?: { existingOnly?: boolean }): Promise<VcsResult> {
		const result = await this.git(cwd, ["push", "origin", `HEAD:${ref}`], 30_000);
		return result.code === 0 ? { ok: true } : { ok: false, error: `git push failed: ${result.stderr.trim()}` };
	}

	/** @deprecated Use publishRecordedChanges. */
	push(cwd: string, ref: string): Promise<VcsResult> {
		return this.publishRecordedChanges(cwd, ref);
	}

	private async fetch(cwd: string, ref?: string): Promise<VcsResult> {
		const result = await this.git(cwd, ["fetch", "origin", ...(ref ? [ref] : [])], 60_000);
		return result.code === 0
			? { ok: true }
			: { ok: false, error: `git fetch origin${ref ? ` ${ref}` : ""} failed: ${result.stderr.trim()}` };
	}

	async fetchRemoteHead(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>> {
		const fetched = await this.fetch(cwd, ref);
		if (!fetched.ok) return fetched;
		const result = await this.git(cwd, ["rev-parse", `origin/${ref}`], 5_000);
		const sha = output(result);
		return result.code === 0 && SHA_RE.test(sha)
			? { ok: true, sha }
			: {
					ok: false,
					error: `Could not resolve origin/${ref} after fetch: ${result.stderr.trim() || result.stdout.trim()}`,
				};
	}

	async updateBase(cwd: string, baseRef: string): Promise<MergeBaseResult> {
		const fetched = await this.fetch(cwd, baseRef);
		if (!fetched.ok) return { kind: "failed", error: fetched.error };
		const before = await this.headSha(cwd);
		if (!before.ok) {
			return { kind: "failed", error: `Could not read HEAD before merging origin/${baseRef}: ${before.error}` };
		}
		const merge = await this.git(cwd, ["merge", "--no-edit", `origin/${baseRef}`], 30_000);
		if (merge.code === 0) {
			const after = await this.headSha(cwd);
			if (!after.ok) return { kind: "failed", error: "merge succeeded but HEAD SHA could not be read." };
			return after.sha === before.sha ? { kind: "already-current" } : { kind: "clean", headSha: after.sha };
		}
		const unmerged = await this.git(cwd, ["diff", "--name-only", "--diff-filter=U"], 5_000);
		const files = unmerged.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		await this.git(cwd, ["merge", "--abort"]);
		if (files.length > 0) {
			return {
				kind: "needs-human",
				files,
				error: `Merge of origin/${baseRef} conflicted in ${files.join(", ")}. Competing intents need a human.`,
			};
		}
		return {
			kind: "failed",
			error: `git merge origin/${baseRef} failed: ${merge.stderr.trim() || merge.stdout.trim()}`,
		};
	}

	/** @deprecated Use updateBase. */
	mergeBaseIntoHead(cwd: string, baseRef: string): Promise<MergeBaseResult> {
		return this.updateBase(cwd, baseRef);
	}

	/** @deprecated Use verifyRecordedWorkstream. */
	verifyCommittedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>> {
		return this.verifyRecordedWorkstream(cwd, expected);
	}
}
