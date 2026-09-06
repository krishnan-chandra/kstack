/**
 * Shared types for the pr-autopilot extension.
 *
 * The PR autopilot is a bounded child-agent workflow: it owns a single
 * PR at a time (the lowest unmerged PR), classifies its state with one randomly
 * chosen model child, addresses review threads and CI failures it can fix,
 * pushes, and re-checks — stopping at merge-ready. It never auto-merges, never
 * re-stacks shared history, and never uses anything other than one model from
 * the model pool in kstack.json.
 */

import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import type { ModelThinkingLevel } from "../shared/kstack-config.ts";
import type { ModelSpec } from "../shared/model-spec.ts";

/** Autopilot modes — the explicit user-facing entry points. */
export type AutopilotMode = "check" | "threads" | "drive" | "watch" | "cleanup";

/** Child-agent roles inside the autopilot loop. */
export type AutopilotAgentRole = "triager" | "fixer";

export type AutopilotThinkingLevel = ModelThinkingLevel;

/** A model entry in the pr-autopilot config, with a short run label. */
export interface AutopilotModelSpec extends Omit<ModelSpec, "thinking"> {
	/** Short run label (e.g. "luna", "flash"). */
	label: string;
	/** Thinking level for the child; defaults to "low". */
	thinking?: AutopilotThinkingLevel;
}

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** Resolved pr-autopilot configuration. */
export interface ResolvedAutopilotConfig {
	models: AutopilotModelSpec[];
	maxConcurrency: number;
	timeoutMinutes: number;
	maxRuntimeMinutes: number;
	source: "config" | "default";
	warnings: string[];
}

/** A GitHub check run / CI job as surfaced by `gh pr checks`. */
export interface CheckRun {
	name: string;
	status: "success" | "failure" | "cancelled" | "pending" | "neutral" | "skipped";
	conclusion: "success" | "failure" | "cancelled" | "pending" | "neutral" | "skipped" | null;
	detailsUrl?: string;
	/** GitHub Actions run id, when the details URL points at an Actions run. */
	runId?: string;
	/** Capped failed-log excerpt. Absent when the log could not be fetched. */
	logExcerpt?: string;
}

/** Where a review item came from. */
export type ThreadSource = "review-thread" | "issue-comment";

/** Full, untruncated evidence used to version one represented review comment. */
export interface ReviewCommentEvidence {
	id: string;
	body: string;
	updatedAt: string;
	author: string | null;
	path?: string;
	line?: number;
}

/**
 * An unresolved review thread or an issue comment that still needs a decision.
 * Resolved GraphQL threads are dropped at fetch time, so this array is the
 * actionable set.
 */
export interface ReviewThread {
	id: string;
	commenter: string;
	body: string;
	path?: string;
	line?: number;
	url?: string;
	/** databaseId of the last comment, for `in_reply_to` replies. */
	replyToId?: number;
	source: ThreadSource;
	/** SHA-256 freshness token derived from complete, untruncated review evidence. */
	version: string;
}

/** Triager decision for one review item. */
export type ThreadDecision = "fix" | "dismiss" | "ask" | "ignore";

/** Decisions that complete handling and may be persisted. */
type HandledReviewDecision = Exclude<ThreadDecision, "ask">;

export interface HandledReviewRecord {
	id: string;
	source: ThreadSource;
	version: string;
	decision: HandledReviewDecision;
}

export interface PendingReviewReply {
	id: string;
	version: string;
}

/**
 * A check-run classification produced by the model triager: tells the
 * autopilot whether a failure is the diff's own code, a stale base, or
 * infrastructure flakiness — before any retrigger is attempted.
 */
export type FailureClass = "code" | "stale-base" | "flake" | "infra" | "unknown";

/** GitHub `mergeStateStatus` values from `gh pr view`. */
export type MergeStateStatus =
	| "CLEAN"
	| "DIRTY"
	| "BEHIND"
	| "BLOCKED"
	| "DRAFT"
	| "UNKNOWN"
	| "UNSTABLE"
	| "HAS_HOOKS";

/** Complete PR state snapshot that drives an autopilot decision. */
export interface PRState {
	number: number;
	title: string;
	state: "open" | "closed" | "merged";
	isDraft: boolean;
	headSha: string;
	/** SHA the head was last verified against (pinned verification). */
	verifiedHeadSha: string | null;
	baseRef: string;
	headRef: string;
	mergeable: "mergeable" | "conflicting" | "unknown";
	mergeStateStatus: MergeStateStatus;
	checks: CheckRun[];
	threads: ReviewThread[];
	/** Whether the PR is blocked by unaddressed review items. */
	hasUnresolvedThreads: boolean;
}

/* exported: stable cross-extension blocker code */
export type AutopilotBlockedCode = "ci-pending-after-watch";

/** Outcome of a full autopilot run. */
export interface AutopilotResult {
	status: "merge-ready" | "blocked" | "declined" | "incomplete" | "cleaned" | "aborted" | "failed";
	prState?: PRState;
	mergeReady: boolean;
	cyclesCompleted: number;
	blockedReasons: string[];
	/** Stable codes for callers that need to branch on known blockers; absent means no recognized code was emitted. */
	blockedCodes?: AutopilotBlockedCode[];
	usage: UsageSummary;
}

/** Persisted across ticks so a later drive/watch resume does not re-handle work. */
export interface AutopilotPersistedState {
	schemaVersion: 2;
	repoKey: string;
	prNumber: number;
	headSha: string;
	/** Completed review handling, ordered oldest to newest. */
	handled: HandledReviewRecord[];
	/** Replies posted for an exact evidence version whose thread resolution is still pending. */
	pendingReviewReplies: PendingReviewReply[];
	/** Migrated v1 reply IDs whose evidence version cannot be proven. */
	legacyPendingReplyIds: string[];
	/** Check name + SHA pairs already given one flake rerun. */
	flakeRetried: string[];
}

/** Load diagnostics stay out of the versioned on-disk schema. */
export type LoadedAutopilotState =
	| { kind: "ready"; state: AutopilotPersistedState; migrationNote?: string }
	| {
			kind: "blocked";
			state: AutopilotPersistedState;
			/** Invalid or unreadable state blocks reply and resolution mutations until a user reconciles the file. */
			reviewMutationBlocker: string;
	  };

export type { ExecFn, ExecFnResult };

/** Resource and concurrency limits enforced by the autopilot. */
export const LIMITS = {
	/** Maximum PRs traversed in the frontier sweep (always pick the lowest). */
	maxFrontierPRs: 5,
	/** AutopilotMode default timeout (minutes) applied to child agents. */
	defaultTimeoutMinutes: 5,
	minTimeoutMinutes: 1,
	maxTimeoutMinutes: 15,
	/** Default absolute runtime ceiling for a child agent (minutes). */
	defaultMaxRuntimeMinutes: 15,
	minRuntimeMinutes: 2,
	maxRuntimeMinutes: 60,
	/** Max concurrent model children / log fetches. */
	defaultMaxConcurrency: 3,
	minConcurrency: 1,
	maxConcurrency: 5,
	/** Output cap for a child agent's final text. */
	outputBytes: 16 * 1024,
	stderrBytes: 8 * 1024,
	stdoutLineBytes: 2 * 1024 * 1024,
	killGraceMs: 5000,
	/** Capped failed-log excerpt stored on a CheckRun. */
	logExcerptBytes: 6 * 1024,
	/** Body slice shown to the triager (full body still used for sensitivity). */
	threadBodyChars: 400,
	/** Most recent non-autopilot issue comments retained after pagination. */
	issueComments: 100,
	/** Outer review-thread connection pages. */
	reviewThreadPages: 20,
	/** Complete represented comments allowed for one review thread. */
	reviewCommentsPerThread: 500,
	/** Complete represented comments allowed across one review-thread fetch. */
	reviewCommentsPerFetch: 5000,
	/** Completed and pending review-handling record bounds. */
	reviewHandlingRecords: 1000,
	/** Drive mode: max fix/push cycles (watches do not count). */
	maxDriveCycles: 3,
	/** Watch mode: max fix/push cycles while waiting on GitHub. */
	maxWatchCycles: 15,
	/** Timeout for `gh pr checks --watch`. */
	watchTimeoutMinutes: 20,
} as const;
