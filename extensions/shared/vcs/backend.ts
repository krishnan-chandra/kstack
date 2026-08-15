import type { VcsBackendId } from "./config.ts";

export type VcsResult<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string };

export type CurrentRef =
	| { kind: "branch"; name: string }
	| { kind: "bookmark"; name: string }
	| { kind: "detached" }
	| { kind: "no-bookmark"; changeId: string };

export interface WorkstreamCheckpoint {
	ref: string;
	baseSha: string;
}

interface GitIsolationPlan {
	kind: "git-worktree";
	sourceRepoRoot: string;
	commonGitDir: string;
	managedRoot: string;
	repositoryId: string;
	slug: string;
	ref: string;
	path: string;
	baseRef: string;
	baseSha: string;
}

export type IsolationPlan = GitIsolationPlan;

export type MergeBaseResult =
	| { kind: "clean"; headSha: string }
	| { kind: "already-current" }
	| { kind: "needs-human"; files: string[]; error: string }
	| { kind: "failed"; error: string };

export interface VcsBackend {
	readonly id: VcsBackendId;
	preflight(cwd: string): Promise<VcsResult<{ workspaceRoot: string }>>;
	workspaceRoot(cwd: string): Promise<VcsResult<{ path: string }>>;
	headSha(cwd: string): Promise<VcsResult<{ sha: string }>>;
	currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>>;
	changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>>;
	isWorkingCopyEmpty(cwd: string): Promise<VcsResult<{ empty: boolean; details?: string }>>;
	createWorkstream(cwd: string, task: string): Promise<VcsResult<WorkstreamCheckpoint>>;
	verifyCommittedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>>;
	planIsolation(cwd: string, task: string): Promise<VcsResult<{ plan: IsolationPlan }>>;
	createIsolation(plan: IsolationPlan): Promise<VcsResult<{ plan: IsolationPlan }>>;
	removeIsolation(cwd: string, ref: string): Promise<VcsResult<{ warning?: string }>>;
	commitPaths(cwd: string, paths: string[], message: string): Promise<VcsResult>;
	restorePaths(cwd: string, paths: string[]): Promise<VcsResult>;
	push(cwd: string, ref: string): Promise<VcsResult>;
	fetch(cwd: string, ref?: string): Promise<VcsResult>;
	integrateRemoteHead(cwd: string, ref: string): Promise<VcsResult>;
	mergeBaseIntoHead(cwd: string, baseRef: string): Promise<MergeBaseResult>;
}
