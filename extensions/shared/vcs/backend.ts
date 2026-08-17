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

/** Opaque, backend-owned evidence that a checked-out workstream has not moved. */
export interface WorkstreamSnapshot {
	readonly ref: string;
	readonly token: string;
}

/* exported: VCS backend contract */
export interface VcsDescriptor {
	readonly refNoun: string;
	readonly workstreamNoun: string;
	readonly baseUpdateVerb: string;
}

export type MergeBaseResult =
	| { kind: "clean"; headSha: string }
	| { kind: "already-current" }
	| { kind: "needs-human"; files: string[]; error: string }
	| { kind: "failed"; error: string };

/* exported: VCS backend contract */
export interface IsolationBackend {
	plan(cwd: string, task: string): Promise<VcsResult<{ plan: IsolationPlan }>>;
	create(plan: IsolationPlan): Promise<VcsResult<{ plan: IsolationPlan }>>;
	remove(cwd: string, ref: string): Promise<VcsResult<{ warning?: string }>>;
}

/** Optional guard for backends whose local record/update can rewrite other refs. */
/* exported: VCS backend contract */
export interface RewriteScopeGuard {
	assertSingleRef(cwd: string, ref: string): Promise<VcsResult<{ affectedRefs: readonly string[] }>>;
}

/** Optional parent-owned publication path for backends that prohibit generic pushes. */
/* exported: VCS backend contract */
export interface ParentOwnedPublication {
	publish(cwd: string, ref: string, options?: { existingOnly?: boolean }): Promise<VcsResult>;
}

export interface VcsBackend {
	readonly id: VcsBackendId;
	readonly descriptor: VcsDescriptor;
	readonly isolation?: IsolationBackend;
	readonly rewriteScope?: RewriteScopeGuard;
	readonly parentOwnedPublication?: ParentOwnedPublication;
	preflight(cwd: string): Promise<VcsResult<{ workspaceRoot: string }>>;
	headSha(cwd: string): Promise<VcsResult<{ sha: string }>>;
	currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>>;
	captureWorkstream(cwd: string): Promise<VcsResult<{ snapshot: WorkstreamSnapshot }>>;
	assertWorkstreamUnchanged(cwd: string, expected: WorkstreamSnapshot): Promise<VcsResult>;
	changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>>;
	isWorkingCopyEmpty(cwd: string): Promise<VcsResult<{ empty: boolean; details?: string }>>;
	createWorkstream(cwd: string, task: string): Promise<VcsResult<WorkstreamCheckpoint>>;
	verifyRecordedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>>;
	recordPaths(cwd: string, paths: string[], message: string): Promise<VcsResult>;
	restorePaths(cwd: string, paths: string[]): Promise<VcsResult>;
	publishRecordedChanges(cwd: string, ref: string, options?: { existingOnly?: boolean }): Promise<VcsResult>;
	fetchRemoteHead(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>>;
	updateBase(cwd: string, baseRef: string): Promise<MergeBaseResult>;
	childGuidance(): string;
}

export interface GitVcsBackend extends VcsBackend {
	readonly id: "git";
	readonly isolation: IsolationBackend;
	/** @deprecated Use isolation.plan. */
	planIsolation(cwd: string, task: string): Promise<VcsResult<{ plan: IsolationPlan }>>;
	/** @deprecated Use isolation.create. */
	createIsolation(plan: IsolationPlan): Promise<VcsResult<{ plan: IsolationPlan }>>;
	/** @deprecated Use isolation.remove. */
	removeIsolation(cwd: string, ref: string): Promise<VcsResult<{ warning?: string }>>;
	/** @deprecated Use captureWorkstream. */
	workstreamIdentity(cwd: string): Promise<VcsResult<{ identity: { kind: "git"; ref: string; headSha: string } }>>;
	/** @deprecated Use verifyRecordedWorkstream. */
	verifyCommittedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>>;
	/** @deprecated Use recordPaths. */
	commitPaths(cwd: string, paths: string[], message: string): Promise<VcsResult>;
	/** @deprecated Use publishRecordedChanges. */
	push(cwd: string, ref: string): Promise<VcsResult>;
	/** @deprecated Use updateBase. */
	mergeBaseIntoHead(cwd: string, baseRef: string): Promise<MergeBaseResult>;
}

export interface JjVcsBackend extends VcsBackend {
	readonly id: "jj";
	/** @deprecated Use captureWorkstream. */
	workstreamIdentity(
		cwd: string,
	): Promise<VcsResult<{ identity: { kind: "jj"; ref: string; changeId: string; parentCommitIds: string[] } }>>;
	/** @deprecated Use verifyRecordedWorkstream. */
	verifyCommittedWorkstream(
		cwd: string,
		expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
	): Promise<VcsResult<{ headSha: string }>>;
	/** @deprecated Use recordPaths. */
	commitPaths(cwd: string, paths: string[], message: string): Promise<VcsResult>;
	/** @deprecated Use publishRecordedChanges. */
	push(cwd: string, ref: string): Promise<VcsResult>;
	/** @deprecated Use updateBase. */
	mergeBaseIntoHead(cwd: string, baseRef: string): Promise<MergeBaseResult>;
}
