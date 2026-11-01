import type { VcsBackendId } from "./config.ts";
import type { PrMutation } from "./mutation.ts";

export type VcsResult<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string };

export type CurrentRef =
	| { kind: "branch"; name: string }
	| { kind: "bookmark"; name: string }
	| { kind: "detached" }
	| { kind: "no-bookmark"; changeId: string };

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

/** Removal of a clean Kstack-managed Git worktree and its branch. */
interface ManagedWorktreeCleanup {
	remove(cwd: string, ref: string): Promise<VcsResult<{ warning?: string }>>;
}

/** Optional guard for backends whose local record/update can rewrite other refs. */
interface RewriteScopeGuard {
	assertSingleRef(cwd: string, ref: string): Promise<VcsResult<{ affectedRefs: readonly string[] }>>;
}

/** Backend-specific checkout semantics for mutating an existing review head. */
interface MutationWorkstreamBackend {
	open(cwd: string, ref: string, headSha: string): Promise<VcsResult<{ snapshot: WorkstreamSnapshot }>>;
	publishedHeadSha(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>>;
}

/** The configured backend as workflows outside `shared/vcs/` see it. */
export interface VcsBackend {
	readonly id: VcsBackendId;
	/** Present only for backends with Kstack-managed Git worktrees (Git and Graphite). */
	readonly managedWorktree?: ManagedWorktreeCleanup;
	preflight(cwd: string): Promise<VcsResult<{ workspaceRoot: string }>>;
	currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>>;
	/** Open the PR mutation workflow over this backend's primitives. */
	prMutation(options?: { signal?: AbortSignal }): PrMutation;
}

/** Backend primitives sequenced only by the PR mutation workflow in `mutation.ts`. */
export interface WorkstreamPrimitives {
	readonly id: VcsBackendId;
	readonly rewriteScope?: RewriteScopeGuard;
	readonly mutationWorkstream?: MutationWorkstreamBackend;
	headSha(cwd: string): Promise<VcsResult<{ sha: string }>>;
	currentRef(cwd: string): Promise<VcsResult<{ ref: CurrentRef }>>;
	captureWorkstream(cwd: string): Promise<VcsResult<{ snapshot: WorkstreamSnapshot }>>;
	assertWorkstreamUnchanged(cwd: string, expected: WorkstreamSnapshot): Promise<VcsResult>;
	changedPaths(cwd: string): Promise<VcsResult<{ paths: string[] }>>;
	isWorkingCopyEmpty(cwd: string): Promise<VcsResult<{ empty: boolean; details?: string }>>;
	recordPaths(cwd: string, paths: string[], message: string): Promise<VcsResult>;
	restorePaths(cwd: string, paths: string[]): Promise<VcsResult>;
	publishRecordedChanges(cwd: string, ref: string, options?: { existingOnly?: boolean }): Promise<VcsResult>;
	fetchRemoteHead(cwd: string, ref: string): Promise<VcsResult<{ sha: string }>>;
	updateBase(cwd: string, baseRef: string): Promise<MergeBaseResult>;
}
