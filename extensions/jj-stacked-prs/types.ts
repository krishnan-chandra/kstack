/** Public domain types and result unions for stacked-PR inspection and publication. */

export const SCHEMA_VERSION = 1;
export const DEFAULT_MAX_STACK = 50;
export const MIN_MAX_STACK = 1;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const GH_TIMEOUT_MS = 30_000;
export const STDOUT_CAP_BYTES = 512 * 1024;
export const STDERR_CAP_BYTES = 64 * 1024;
export const DIAGNOSTICS_CAP_BYTES = 8 * 1024;
export const KILL_GRACE_MS = 5_000;
export const PLAN_ID_DISPLAY_CHARS = 16;
export const CHANGE_ID_DISPLAY_CHARS = 12;
export const COMMIT_ID_DISPLAY_CHARS = 12;
export const MAX_NAVIGATION_ENTRIES = 100;
export const MAX_NAVIGATION_COMMENT_BYTES = 60_000;
export const KSTACK_COMMENT_MARKER = "<!-- kstack-stack-nav -->";
export const KSTACK_COMMENT_SCHEMA_VERSION = 1;
export const TOOL_CONTENT_MAX_BYTES = 50 * 1024;
export const TOOL_CONTENT_MAX_LINES = 2_000;
export const MAX_NAME_CHARS = 256;
export const MAX_REVSET_CHARS = 256;
export const MAX_SUBJECT_CHARS = 500;

export const TRUNK_BOOKMARK_NAMES: ReadonlySet<string> = new Set(["main", "master", "trunk"]);

export interface StackCommit {
	changeId: string;
	commitId: string;
	subject: string;
	bookmarks: readonly string[];
	remoteBookmarks: readonly string[];
	parentCommitIds: readonly string[];
	empty: boolean;
	conflict: boolean;
	divergent: boolean;
	merge: boolean;
	workingCopy: boolean;
}

export interface StackSlice {
	bookmark: string;
	baseBookmark: string | null;
	changeIds: readonly string[];
	subject: string;
}

export type StackBlocker =
	| {
			code: "missing-top" | "empty-stack" | "top-not-final-boundary" | "not-rooted-at-trunk" | "unbookmarked-tail";
			message: string;
	  }
	| {
			code: "conflict" | "divergence" | "merge" | "empty-boundary" | "empty-description";
			message: string;
			changeId: string;
	  }
	| {
			code:
				| "multiple-bookmarks"
				| "ambiguous-local-bookmark"
				| "remote-bookmark-conflict"
				| "ambiguous-pr"
				| "ambiguous-top"
				| "base-chain-mismatch"
				| "head-mismatch"
				| "out-of-order-merge"
				| "land-unavailable";
			message: string;
			bookmark?: string;
	  }
	| {
			code: "truncated" | "missing-remote" | "ambiguous-remote" | "non-github-remote";
			message: string;
	  };

export interface BookmarkTarget {
	name: string;
	commitId: string;
}

export interface GitHubRepository {
	owner: string;
	repo: string;
}

export interface RemoteInfo {
	name: string;
	url: string;
	redactedUrl: string;
	github: GitHubRepository | undefined;
}

export interface OpenPullRequest {
	number: number;
	headRef: string;
	headCommitId: string;
	baseRef: string;
	title: string;
	draft: boolean;
	url: string;
	headOwner: string;
}

export type NavigationStatus = "open" | "draft" | "merged" | "closed" | "unknown";

export interface NavigationEntry {
	prNumber: number | undefined;
	bookmark: string;
	base: string;
	status: NavigationStatus;
}

export type CorePublicationAction =
	| { kind: "push-bookmark"; bookmark: string; localCommitId: string; remoteCommitId: string | null }
	| { kind: "create-draft-pr"; bookmark: string; targetBase: string; provisionalTitle: string }
	| { kind: "repair-pr-base"; bookmark: string; prNumber: number; currentBase: string; targetBase: string };

export interface PublicationSlice {
	bookmark: string;
	baseBookmark: string | null;
	changeIds: readonly string[];
	subject: string;
	targetBase: string;
	localCommitId: string | null;
	remoteCommitId: string | null;
	existingPr: OpenPullRequest | undefined;
	actions: readonly CorePublicationAction[];
}

export interface PublicationPlan {
	planId: string;
	repository: GitHubRepository;
	remote: RemoteInfo;
	defaultBranch: string;
	slices: readonly PublicationSlice[];
	actions: readonly CorePublicationAction[];
	blockers: readonly StackBlocker[];
}

export interface InspectModel {
	schemaVersion: typeof SCHEMA_VERSION;
	jjVersion: string;
	trunk: { revset: string; commitId: string };
	top: string | undefined;
	topCommitId: string | undefined;
	localBookmarks: readonly string[];
	stack: readonly StackCommit[];
	slices: readonly StackSlice[];
	truncated: boolean;
	maxStack: number;
	blockers: readonly StackBlocker[];
}

export interface PublishedPullRequest {
	bookmark: string;
	baseBookmark: string | null;
	changeIds: readonly string[];
	prNumber: number;
	url: string;
	draft: boolean;
}

interface StackPublicationMap {
	repository: GitHubRepository;
	remote: string;
	topBookmark: string;
	pullRequests: readonly PublishedPullRequest[];
}

export type CompletedPublicationAction =
	| { kind: "push-bookmark"; bookmark: string }
	| { kind: "create-draft-pr"; bookmark: string; prNumber: number; url: string }
	| { kind: "repair-pr-base"; bookmark: string; prNumber: number; targetBase: string }
	| { kind: "create-nav-comment"; prNumber: number }
	| { kind: "update-nav-comment"; prNumber: number }
	| { kind: "mark-pr-ready"; bookmark: string; prNumber: number };

export type FailedPublicationAction = {
	kind: CorePublicationAction["kind"] | "nav-comment" | "mark-pr-ready";
	bookmark?: string;
	prNumber?: number;
	error: string;
};

export type StackPublicationOutcome =
	| {
			status: "completed";
			planId: string;
			publication: StackPublicationMap;
			completedActions: readonly CompletedPublicationAction[];
			commentErrors?: readonly string[];
	  }
	| {
			status: "declined";
			planId?: string;
			blockers?: readonly StackBlocker[];
	  }
	| { status: "busy"; message: string }
	| { status: "blocked"; blockers: readonly StackBlocker[]; planId?: string }
	| { status: "stale"; providedPlanId: string; recomputedPlanId: string }
	| {
			status: "partial";
			planId: string;
			completedActions: readonly CompletedPublicationAction[];
			failedAction: FailedPublicationAction;
			commentErrors?: readonly string[];
			publication?: StackPublicationMap;
	  }
	| { status: "cancelled"; completedActions?: readonly CompletedPublicationAction[] }
	| {
			status: "indeterminate";
			planId?: string;
			inFlight: FailedPublicationAction;
			completedActions: readonly CompletedPublicationAction[];
			recovery?: string;
	  }
	| { status: "failed"; error: string; completedActions?: readonly CompletedPublicationAction[] };

export type SyncOutcome =
	| { status: "completed"; operationId: string; blockers: readonly StackBlocker[] }
	| { status: "blocked"; blockers: readonly StackBlocker[] }
	| { status: "declined" }
	| { status: "busy"; message: string }
	| { status: "cancelled"; operationId?: string }
	| { status: "partial"; operationId: string; blockers: readonly StackBlocker[]; error: string }
	| { status: "indeterminate"; operationId?: string; inFlight: string }
	| { status: "failed"; error: string; operationId?: string };

export type AdvanceOutcome =
	| { status: "completed"; operationId: string; remainingTop?: string; blockers: readonly StackBlocker[] }
	| { status: "blocked"; blockers: readonly StackBlocker[] }
	| { status: "declined" }
	| { status: "busy"; message: string }
	| { status: "cancelled"; operationId?: string }
	| { status: "partial"; operationId: string; blockers: readonly StackBlocker[]; error: string }
	| { status: "indeterminate"; operationId?: string; inFlight: string }
	| { status: "failed"; error: string; operationId?: string };

export type StackMergeMethod = "squash" | "rebase";
export type StackReadinessMode = "check" | "watch";

export interface StackLandFrontier {
	bookmark: string;
	prNumber: number;
	url: string;
	expectedHeadSha: string;
	method: StackMergeMethod;
	state: "landed" | "queued" | "blocked" | "not-attempted" | "already-merged";
}

interface StackLandProgress {
	frontiers: readonly StackLandFrontier[];
	remainingBookmarks: readonly string[];
	completedMutations: readonly string[];
	recoveryOperationIds: readonly string[];
}

export type StackLandOutcome =
	| ({ status: "completed" } & StackLandProgress)
	| ({ status: "partial"; error: string } & StackLandProgress)
	| { status: "blocked"; blockers: readonly StackBlocker[] }
	| { status: "declined" }
	| { status: "busy"; message: string }
	| {
			status: "cancelled";
			frontiers?: readonly StackLandFrontier[];
			completedMutations?: readonly string[];
			recoveryOperationIds?: readonly string[];
	  }
	| ({ status: "indeterminate"; inFlight: string; recovery?: string } & StackLandProgress)
	| {
			status: "failed";
			error: string;
			frontiers?: readonly StackLandFrontier[];
			completedMutations?: readonly string[];
			recoveryOperationIds?: readonly string[];
	  };

export interface JjStackCapabilities {
	schemaVersion: typeof SCHEMA_VERSION;
	commands: readonly ["inspect", "plan", "publish", "sync", "advance", "land"];
	tools: readonly ["jj_stack_inspect", "jj_stack_plan", "jj_stack_publish", "jj_stack_land"];
	publication: true;
}

export interface StackPublicationRequestInput {
	repositoryPath: string;
	trunkRevset?: string;
	topBookmark?: string;
	remote?: string;
	signal?: AbortSignal;
}

export interface StackLandingRequestInput {
	repositoryPath: string;
	prNumber: number;
	headBookmark: string;
	readiness: StackReadinessMode;
	method?: StackMergeMethod;
}

export type StackPrefixLandOutcome = { status: "not-stack" } | { status: "stack"; outcome: StackLandOutcome };
