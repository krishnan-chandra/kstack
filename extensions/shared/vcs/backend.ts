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

/** Backend-specific checkout semantics for mutating an existing review head. */
interface MutationWorkstreamBackend {
	open(cwd: string, ref: string, headSha: string): Promise<VcsResult<{ snapshot: WorkstreamSnapshot }>>;
	publishedHeadSha(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>>;
}

export interface VcsBackend {
	readonly id: VcsBackendId;
	readonly isolation?: IsolationBackend;
	readonly rewriteScope?: RewriteScopeGuard;
	readonly parentOwnedPublication?: ParentOwnedPublication;
	readonly mutationWorkstream?: MutationWorkstreamBackend;
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
}
