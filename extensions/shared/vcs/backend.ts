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

export interface IsolationPlan {
	sourceRepoRoot: string;
	ref: string;
	path: string;
	baseRef: string;
	baseSha: string;
}

export type WorkstreamIdentity =
	| { kind: "git"; ref: string; headSha: string }
	| { kind: "jj"; ref: string; changeId: string; parentCommitIds: string[] };

export type MergeBaseResult =
	| { kind: "clean"; headSha: string }
	| { kind: "already-current" }
	| { kind: "needs-human"; files: string[]; error: string }
	| { kind: "failed"; error: string };

interface BaseVcsBackend {
	readonly id: VcsBackendId;
	preflight(cwd: string): Promise<VcsResult<{ workspaceRoot: string }>>;
	headSha(cwd: string): Promise<VcsResult<{ sha: string }>>;
	currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>>;
	workstreamIdentity(cwd: string): Promise<VcsResult<{ identity: WorkstreamIdentity }>>;
	changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>>;
	isWorkingCopyEmpty(cwd: string): Promise<VcsResult<{ empty: boolean; details?: string }>>;
	createWorkstream(cwd: string, task: string): Promise<VcsResult<WorkstreamCheckpoint>>;
	verifyCommittedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>>;
	commitPaths(cwd: string, paths: string[], message: string): Promise<VcsResult>;
	restorePaths(cwd: string, paths: string[]): Promise<VcsResult>;
	push(cwd: string, ref: string): Promise<VcsResult>;
	fetchRemoteHead(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>>;
	mergeBaseIntoHead(cwd: string, baseRef: string): Promise<MergeBaseResult>;
}

export interface GitVcsBackend extends BaseVcsBackend {
	readonly id: "git";
	planIsolation(cwd: string, task: string): Promise<VcsResult<{ plan: IsolationPlan }>>;
	createIsolation(plan: IsolationPlan): Promise<VcsResult<{ plan: IsolationPlan }>>;
	removeIsolation(cwd: string, ref: string): Promise<VcsResult<{ warning?: string }>>;
}

export interface JjVcsBackend extends BaseVcsBackend {
	readonly id: "jj";
}

export type VcsBackend = GitVcsBackend | JjVcsBackend;
