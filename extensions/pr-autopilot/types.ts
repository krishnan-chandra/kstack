/**
 * Shared types for the pr-autopilot extension.
 *
 * The PR autopilot is a bounded, tiny-model-only workflow: it owns a single
 * PR at a time (the lowest unmerged PR), classifies its state with one randomly
 * chosen tiny-model child, addresses review threads and CI failures it can fix,
 * pushes, and re-checks — stopping at merge-ready. It never auto-merges, never
 * re-stacks shared history, and never uses anything other than one model from
 * the tiny-model pool in kstack.json.
 */

import type { ExecFn, ExecFnOptions, ExecFnResult } from "../shared/git-exec.ts";
import type { ModelThinkingLevel } from "../shared/kstack-config.ts";
import type { ModelSpec } from "../shared/model-spec.ts";

/** Autopilot modes — the explicit user-facing entry points. */
export type AutopilotMode = "check" | "threads" | "drive" | "watch" | "cleanup";

/** Tiny-model child roles inside the autopilot loop. */
export type AutopilotAgentRole = "triager" | "fixer";

export type TinyThinkingLevel = Extract<ModelThinkingLevel, "off" | "minimal" | "low">;

/** A model entry in the pr-autopilot config, with a short run label. */
export interface AutopilotModelSpec extends Omit<ModelSpec, "thinking"> {
	/** Short run label (e.g. "luna", "flash"). */
	label: string;
	/** Thinking level for the child; default "low" for tiny models. */
	thinking?: TinyThinkingLevel;
}

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** Resolved pr-autopilot configuration after availability checking. */
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
type ThreadSource = "review-thread" | "issue-comment";

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
}

/** Triager decision for one review item. */
export type ThreadDecision = "fix" | "dismiss" | "ask";

/**
 * A check-run classification produced by the tiny-model triager: tells the
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

/** Persisted across ticks so a later drive/watch resume does not re-handle work. */
export interface AutopilotPersistedState {
	repoKey: string;
	prNumber: number;
	headSha: string;
	/** Review items whose reply and, when applicable, resolution both succeeded. */
	handledThreadIds: string[];
	/** Review threads already replied to but not yet resolved. */
	repliedThreadIds: string[];
	/** Check name + SHA pairs already given one flake rerun. */
	flakeRetried: string[];
}

/** Lifecycle token to guard against overlapping autopilot runs. */
export interface AutopilotToken {
	readonly generation: number;
}

export type { ExecFn, ExecFnOptions, ExecFnResult };

/** Config guardrails the autopilot enforces to stay "tiny-model-only". */
export const LIMITS = {
	/** Maximum PRs traversed in the frontier sweep (always pick the lowest). */
	maxFrontierPRs: 5,
	/** AutopilotMode default timeout (minutes) applied to tiny child agents. */
	defaultTimeoutMinutes: 5,
	minTimeoutMinutes: 1,
	maxTimeoutMinutes: 15,
	/** Default absolute runtime ceiling for a child agent (minutes). */
	defaultMaxRuntimeMinutes: 15,
	minRuntimeMinutes: 2,
	maxRuntimeMinutes: 60,
	/** Max concurrent tiny-model children / log fetches. */
	defaultMaxConcurrency: 3,
	minConcurrency: 1,
	maxConcurrency: 5,
	/** Tiny models use at most "low" thinking. */
	maxThinkingLevel: "low" as const,
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
	/** Drive mode: max fix/push cycles (watches do not count). */
	maxDriveCycles: 3,
	/** Watch mode: max fix/push cycles while waiting on GitHub. */
	maxWatchCycles: 15,
	/** Timeout for `gh pr checks --watch`. */
	watchTimeoutMinutes: 20,
} as const;
