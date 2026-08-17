/** Graphite implementation of the semantic VCS contract. */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import { type acquirePublicationLock, acquireRepositoryPublicationLock } from "../publication-lock.ts";
import { extractSlug } from "../slug.ts";
import type {
	CurrentRef,
	IsolationPlan,
	MergeBaseResult,
	VcsBackend,
	VcsResult,
	WorkstreamCheckpoint,
	WorkstreamSnapshot,
} from "./backend.ts";
import { verifyGraphiteDryRunAffectedRefs } from "./graphite-dry-run.ts";
import { preflightVcs } from "./preflight.ts";
import { planManagedWorktree } from "./worktree-plan.ts";

const MAX_COLLISION_ATTEMPTS = 100;
const SHA_RE = /^[0-9a-f]{40}$/;

interface GraphiteBackendDeps {
	exists?: (path: string) => boolean;
	realpath?: (path: string) => string;
	mkdir?: (path: string) => void;
	unlink?: (path: string) => void;
	managedRoot?: string;
	acquireLock?: typeof acquirePublicationLock;
}

function failure(error: unknown): ExecFnResult {
	return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
}

function diagnostic(result: ExecFnResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

function output(result: ExecFnResult): string {
	return result.stdout.trim();
}

function parsePorcelainPaths(stdout: string): string[] {
	const paths: string[] = [];
	const seen = new Set<string>();
	const fields = stdout.split("\0");
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4) continue;
		const xy = field.slice(0, 2);
		const path = field.slice(3);
		if (path && !seen.has(path)) {
			seen.add(path);
			paths.push(path);
		}
		if (xy.includes("R") || xy.includes("C")) {
			const source = fields[++index];
			if (source && !seen.has(source)) {
				seen.add(source);
				paths.push(source);
			}
		}
	}
	return paths;
}

function isSafeRelativePath(path: string): boolean {
	return path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

/** Graphite owns all workstream mutations; Git is used only for inspection. */
export class GraphiteBackend implements VcsBackend {
	readonly id = "graphite" as const;
	private readonly exec: ExecFn;
	private readonly deps: GraphiteBackendDeps;
	readonly descriptor = {
		refNoun: "Graphite branch",
		workstreamNoun: "Graphite checkout",
		baseUpdateVerb: "restack",
	} as const;
	readonly isolation = {
		plan: (cwd: string, task: string) => this.planIsolation(cwd, task),
		create: (plan: IsolationPlan) => this.createIsolation(plan),
		remove: (cwd: string, ref: string) => this.removeIsolation(cwd, ref),
	};
	readonly rewriteScope = {
		assertSingleRef: (cwd: string, ref: string) => this.assertSingleRefRewrite(cwd, ref),
	};
	readonly parentOwnedPublication = {
		publish: (cwd: string, ref: string, options?: { existingOnly?: boolean }) =>
			this.publishRecordedChanges(cwd, ref, options),
	};

	constructor(exec: ExecFn, deps: GraphiteBackendDeps = {}) {
		this.exec = exec;
		this.deps = deps;
	}

	private async run(command: string, args: string[], cwd: string, timeout = 10_000): Promise<ExecFnResult> {
		try {
			return await this.exec(command, args, { cwd, timeout });
		} catch (error) {
			return failure(error);
		}
	}

	private git(cwd: string, args: string[], timeout?: number): Promise<ExecFnResult> {
		return this.run("git", args, cwd, timeout);
	}

	private gt(cwd: string, args: string[], timeout?: number): Promise<ExecFnResult> {
		return this.run("gt", ["--no-interactive", ...args], cwd, timeout);
	}

	preflight(cwd: string): Promise<VcsResult<{ workspaceRoot: string }>> {
		return preflightVcs(cwd, this.id, this.exec);
	}

	childGuidance(): string {
		return [
			"VCS backend: Graphite.",
			"Use gt for all branch, staging, commit, restore, restack, and submit mutations. Do not run git commit, branch, rebase, or push.",
			"Use gt add, gt create, gt modify, gt restore, and gt checkout. The parent alone publishes or lands work.",
		].join(" ");
	}

	async headSha(cwd: string): Promise<VcsResult<{ sha: string }>> {
		const result = await this.git(cwd, ["rev-parse", "HEAD"], 5_000);
		const sha = output(result);
		return result.code === 0 && SHA_RE.test(sha)
			? { ok: true, sha }
			: { ok: false, error: `Could not resolve the current Graphite HEAD: ${diagnostic(result)}` };
	}

	async currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>> {
		const result = await this.git(cwd, ["branch", "--show-current"], 5_000);
		if (result.code !== 0)
			return { ok: false, error: `Could not resolve the current Graphite branch: ${diagnostic(result)}` };
		const name = output(result);
		return { ok: true, ref: name ? { kind: "branch", name } : { kind: "detached" } };
	}

	async captureWorkstream(cwd: string): Promise<VcsResult<{ snapshot: WorkstreamSnapshot }>> {
		const [current, head] = await Promise.all([this.currentRef(cwd), this.headSha(cwd)]);
		if (!current.ok) return current;
		if (current.ref.kind !== "branch") return { ok: false, error: "The Graphite workstream has no current branch." };
		if (!head.ok) return head;
		return { ok: true, snapshot: { ref: current.ref.name, token: `${current.ref.name}@${head.sha}` } };
	}

	async assertWorkstreamUnchanged(cwd: string, expected: WorkstreamSnapshot): Promise<VcsResult> {
		const actual = await this.captureWorkstream(cwd);
		if (!actual.ok) return actual;
		return actual.snapshot.token === expected.token
			? { ok: true }
			: { ok: false, error: `The Graphite workstream changed (expected ${expected.ref}). Refusing to publish.` };
	}

	async changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>> {
		const status = await this.git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], 5_000);
		if (status.code !== 0)
			return { ok: false, error: `Could not inspect Graphite working-copy changes: ${diagnostic(status)}` };
		return { ok: true, paths: parsePorcelainPaths(status.stdout) };
	}

	async isWorkingCopyEmpty(cwd: string): Promise<VcsResult<{ empty: boolean; details?: string }>> {
		const status = await this.git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], 5_000);
		if (status.code !== 0)
			return { ok: false, error: `Could not inspect the Graphite working copy: ${diagnostic(status)}` };
		const details = output(status);
		return details ? { ok: true, empty: false, details } : { ok: true, empty: true };
	}

	async createWorkstream(cwd: string, task: string): Promise<VcsResult<WorkstreamCheckpoint>> {
		const clean = await this.isWorkingCopyEmpty(cwd);
		if (!clean.ok) return clean;
		if (!clean.empty)
			return { ok: false, error: "The current working tree is dirty; no Graphite task branch was created." };
		const base = await this.headSha(cwd);
		if (!base.ok) return base;
		const slug = extractSlug(task);
		for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
			const ref = `kstack/${slug}${attempt === 1 ? "" : `-${attempt}`}`;
			const exists = await this.git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
			if (exists.code === 0) continue;
			const created = await this.gt(cwd, ["--no-ai", "create", ref, "--message", task], 30_000);
			if (created.code !== 0) return { ok: false, error: `gt create ${ref} failed: ${diagnostic(created)}` };
			const current = await this.currentRef(cwd);
			if (!current.ok || current.ref.kind !== "branch" || current.ref.name !== ref) {
				return { ok: false, error: `gt create succeeded but did not check out ${ref}.` };
			}
			return { ok: true, ref, baseSha: base.sha };
		}
		return {
			ok: false,
			error: `Could not allocate a unique Graphite branch after ${MAX_COLLISION_ATTEMPTS} attempts.`,
		};
	}

	async verifyRecordedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>> {
		const current = await this.currentRef(cwd);
		const actual = current.ok && current.ref.kind === "branch" ? current.ref.name : "detached HEAD";
		if (!current.ok || actual !== expected.ref)
			return { ok: false, error: `Expected Graphite branch ${expected.ref}, found ${actual}.` };
		const head = await this.headSha(cwd);
		if (!head.ok) return head;
		if (expected.requireNewCommit && head.sha === expected.baseSha) {
			return { ok: false, error: "Graphite workstream postcondition failed: implementation created no commits." };
		}
		const clean = await this.isWorkingCopyEmpty(cwd);
		if (!clean.ok) return clean;
		return clean.empty
			? { ok: true, headSha: head.sha }
			: { ok: false, error: `Uncommitted files remain.\n${clean.details ?? ""}` };
	}

	async recordPaths(cwd: string, paths: string[], message: string): Promise<VcsResult> {
		if (paths.length === 0 || paths.some((path) => !isSafeRelativePath(path))) {
			return { ok: false, error: "Graphite recording requires one or more safe cwd-relative paths." };
		}
		const before = await this.headSha(cwd);
		if (!before.ok) return before;
		const add = await this.gt(cwd, ["add", "--", ...paths], 30_000);
		if (add.code !== 0) return { ok: false, error: `gt add failed: ${diagnostic(add)}` };
		const recorded = await this.gt(cwd, ["--no-ai", "modify", "--commit", "--message", message], 30_000);
		if (recorded.code !== 0) return { ok: false, error: `gt modify failed: ${diagnostic(recorded)}` };
		const after = await this.headSha(cwd);
		if (!after.ok) return after;
		return after.sha === before.sha
			? { ok: false, error: "gt modify succeeded but did not create a new commit." }
			: { ok: true };
	}

	async restorePaths(cwd: string, paths: string[]): Promise<VcsResult> {
		for (const path of paths) {
			if (!isSafeRelativePath(path)) return { ok: false, error: `Refusing to restore unsafe path: ${path}` };
			const tracked = await this.git(cwd, ["ls-files", "--error-unmatch", "--", path], 5_000);
			if (tracked.code === 0) {
				const restored = await this.gt(cwd, ["restore", "--staged", "--worktree", "--", path], 30_000);
				if (restored.code !== 0) return { ok: false, error: `gt restore ${path} failed: ${diagnostic(restored)}` };
				continue;
			}
			if (tracked.code !== 1) {
				return { ok: false, error: `Could not determine whether ${path} is tracked: ${diagnostic(tracked)}` };
			}
			try {
				(this.deps.unlink ?? unlinkSync)(join(cwd, path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				return {
					ok: false,
					error: `Could not remove untracked path ${path}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}
		return { ok: true };
	}

	async publishRecordedChanges(cwd: string, ref: string, options?: { existingOnly?: boolean }): Promise<VcsResult> {
		const lock = await acquireRepositoryPublicationLock(this.exec, cwd, {
			acquireLock: this.deps.acquireLock,
			realpath: this.deps.realpath,
		});
		if (!lock.ok) {
			return {
				ok: false,
				error:
					lock.kind === "busy" ? "Another Graphite publication or landing is active for this repository." : lock.error,
			};
		}
		try {
			const current = await this.currentRef(cwd);
			if (!current.ok || current.ref.kind !== "branch" || current.ref.name !== ref) {
				return { ok: false, error: `Refusing to submit: the checked-out Graphite branch is not ${ref}.` };
			}
			const head = await this.headSha(cwd);
			if (!head.ok) return head;
			const submitArgs = ["--no-ai", "submit", "--no-stack", "--draft", "--no-edit"];
			if (options?.existingOnly) submitArgs.push("--update-only");
			const dryRun = await this.gt(cwd, [...submitArgs, "--dry-run"], 60_000);
			if (dryRun.code !== 0) return { ok: false, error: `gt submit --dry-run failed: ${diagnostic(dryRun)}` };
			const scope = verifyGraphiteDryRunAffectedRefs(`${dryRun.stdout}\n${dryRun.stderr}`, "submit", [ref]);
			if (!scope.ok) return { ok: false, error: `Refusing Graphite submission: ${scope.error}` };
			const submitted = await this.gt(cwd, submitArgs, 60_000);
			const remote = await this.fetchRemoteHead(cwd, ref);
			if (remote.ok && remote.sha === head.sha) return { ok: true };
			if (submitted.code !== 0) {
				const observed = remote.ok ? `origin/${ref} resolved to ${remote.sha}` : remote.error;
				return {
					ok: false,
					error: `gt submit may have started before it returned ${diagnostic(submitted)}; ${observed}. Remote publication is indeterminate; inspect the PR and branch before retrying, and do not retry blindly.`,
				};
			}
			return {
				ok: false,
				error: remote.ok
					? `Graphite submitted ${ref}, but origin resolved to ${remote.sha} instead of ${head.sha}. Inspect the PR and branch before retrying.`
					: `Graphite submitted ${ref}, but remote verification failed: ${remote.error}. Inspect the PR and branch before retrying.`,
			};
		} finally {
			lock.lock.release();
		}
	}

	async fetchRemoteHead(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>> {
		const fetched = await this.git(cwd, ["fetch", "origin", ref], 60_000);
		if (fetched.code !== 0) return { ok: false, error: `git fetch origin ${ref} failed: ${diagnostic(fetched)}` };
		const head = await this.git(cwd, ["rev-parse", `origin/${ref}`], 5_000);
		const sha = output(head);
		return head.code === 0 && SHA_RE.test(sha)
			? { ok: true, sha }
			: { ok: false, error: `Could not resolve origin/${ref}: ${diagnostic(head)}` };
	}

	async updateBase(cwd: string, _baseRef: string): Promise<MergeBaseResult> {
		const before = await this.headSha(cwd);
		if (!before.ok) return { kind: "failed", error: before.error };
		const synced = await this.gt(cwd, ["get", _baseRef, "--downstack", "--no-checkout", "--no-restack"], 60_000);
		if (synced.code !== 0) return { kind: "failed", error: `gt get ${_baseRef} failed: ${diagnostic(synced)}` };
		const restacked = await this.gt(cwd, ["restack", "--only"], 60_000);
		if (restacked.code !== 0) return { kind: "failed", error: `gt restack failed: ${diagnostic(restacked)}` };
		const after = await this.headSha(cwd);
		if (!after.ok) return { kind: "failed", error: after.error };
		return after.sha === before.sha ? { kind: "already-current" } : { kind: "clean", headSha: after.sha };
	}

	private async assertSingleRefRewrite(
		cwd: string,
		ref: string,
	): Promise<VcsResult<{ affectedRefs: readonly string[] }>> {
		const current = await this.currentRef(cwd);
		if (!current.ok || current.ref.kind !== "branch" || current.ref.name !== ref) {
			return { ok: false, error: `Graphite mutation requires ${ref} to be checked out.` };
		}
		const children = await this.gt(cwd, ["children"], 8_000);
		if (children.code !== 0) {
			return { ok: false, error: `Could not prove the Graphite rewrite scope: ${diagnostic(children)}` };
		}
		if (output(children)) {
			return {
				ok: false,
				error:
					`Graphite branch ${ref} has local descendants. Kstack cannot safely account for their rewrites without verified stack evidence; ` +
					"run the repair from the top branch or use native Graphite.",
			};
		}
		return { ok: true, affectedRefs: [ref] };
	}

	private async planIsolation(cwd: string, task: string): Promise<VcsResult<{ plan: IsolationPlan }>> {
		const planned = await planManagedWorktree({
			exec: this.exec,
			cwd,
			task,
			managedRoot: this.deps.managedRoot,
			exists: this.deps.exists,
			realpath: this.deps.realpath,
		});
		if (!planned.ok) return planned;
		const trunk = await this.gt(planned.plan.sourceRepoRoot, ["trunk"], 8_000);
		const baseRef = output(trunk);
		if (trunk.code !== 0 || !baseRef)
			return { ok: false, error: `Could not resolve the Graphite trunk: ${diagnostic(trunk)}` };
		const base = await this.git(
			planned.plan.sourceRepoRoot,
			["rev-parse", "--verify", `refs/heads/${baseRef}^{commit}`],
			8_000,
		);
		const baseSha = output(base);
		if (base.code !== 0 || !SHA_RE.test(baseSha))
			return { ok: false, error: `Could not resolve Graphite trunk ${baseRef}.` };
		return { ok: true, plan: { ...planned.plan, baseRef, baseSha } };
	}

	private async createIsolation(plan: IsolationPlan): Promise<VcsResult<{ plan: IsolationPlan }>> {
		const branch = await this.git(plan.sourceRepoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${plan.ref}`]);
		if (branch.code === 0 || (this.deps.exists ?? existsSync)(plan.path)) {
			return {
				ok: false,
				error: `Worktree destination or branch appeared after preflight: ${plan.path} (${plan.ref}).`,
			};
		}
		try {
			(this.deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true })))(dirname(plan.path));
		} catch (error) {
			return {
				ok: false,
				error: `Could not create the managed worktree directory: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const added = await this.git(
			plan.sourceRepoRoot,
			["worktree", "add", "--no-guess-remote", "-b", plan.ref, plan.path, plan.baseSha],
			30_000,
		);
		if (added.code !== 0) return { ok: false, error: `git worktree add failed: ${diagnostic(added)}` };
		const tracked = await this.gt(plan.path, ["track", plan.ref, "--parent", plan.baseRef], 30_000);
		if (tracked.code !== 0) {
			const rollback = await this.git(plan.sourceRepoRoot, ["worktree", "remove", plan.path, "--force"], 30_000);
			return {
				ok: false,
				error: `gt track failed: ${diagnostic(tracked)}. ${rollback.code === 0 ? `The worktree was removed; branch ${plan.ref} was retained for inspection.` : `Worktree rollback also failed: ${diagnostic(rollback)}`}`,
			};
		}
		const current = await this.currentRef(plan.path);
		if (!current.ok || current.ref.kind !== "branch" || current.ref.name !== plan.ref) {
			return {
				ok: false,
				error: `Graphite worktree creation succeeded but ${plan.ref} is not checked out at ${plan.path}.`,
			};
		}
		return { ok: true, plan };
	}

	private async removeIsolation(cwd: string, ref: string): Promise<VcsResult<{ warning?: string }>> {
		const common = await this.git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 5_000);
		const commonDir = output(common);
		if (common.code !== 0 || !commonDir)
			return { ok: false, error: `Could not locate the owning repository: ${diagnostic(common)}` };
		const ownerRoot = join(commonDir, "..");
		const removed = await this.git(ownerRoot, ["worktree", "remove", cwd, "--force"], 30_000);
		if (removed.code !== 0) return { ok: false, error: `Worktree removal failed: ${diagnostic(removed)}` };
		const deleted = await this.gt(ownerRoot, ["delete", ref], 30_000);
		return deleted.code === 0
			? { ok: true }
			: {
					ok: true,
					warning: `The worktree was removed, but Graphite preserved ${ref}: ${diagnostic(deleted)}. Delete it explicitly with gt delete ${ref} when safe.`,
				};
	}
}
