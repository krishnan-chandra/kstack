/**
 * Shared types for the pr-autopilot extension.
 *
 * The PR autopilot is a bounded, tiny-model-only workflow: it owns a single
 * PR frontier at a time (the lowest unmerged PR), classifies its state with
 * small child agents, addresses review threads and CI failures it can fix,
 * pushes, and re-checks — stopping at merge-ready. It never auto-merges, never
 * re-stacks shared history, and never uses anything other than the tiny models
 * recorded in kstack.json.
 */

/** Autopilot modes — the explicit user-facing entry points. */
export type AutopilotMode = "check" | "threads" | "drive" | "watch" | "cleanup";

/** Tiny-model child roles inside the autopilot loop. */
export type AutopilotAgentRole = "triager" | "fixer";

/** A model entry in the pr-autopilot config, with a short run label. */
export interface AutopilotModelSpec {
	/** Short run label (e.g. "luna", "flash"). */
	label: string;
	/** Pi model id in "provider/model" form. */
	model: string;
	/** Thinking level for the child; default "low" for tiny models. */
	thinking?: string;
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
	status: "success" | "failure" | "pending" | "neutral" | "skipped";
	conclusion: "success" | "failure" | "pending" | "neutral" | "skipped" | null;
	detailsUrl?: string;
	/** GitHub Actions run id, when the details URL points at an Actions run. */
	runId?: string;
	/** Capped failed-log excerpt. Absent when the log could not be fetched. */
	logExcerpt?: string;
}

/** Where a review item came from. */
export type ThreadSource = "review-thread" | "issue-comment";

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

/**
 * Outcome of one autopilot cycle iteration. The state machine keys off this to
 * decide whether to fix-and-push again, declare merge-ready, or report a
 * blocker.
 */
export interface CycleResult {
	/** Did the PR reach a merge-ready state on this cycle? */
	mergeReady: boolean;
	/** Threads that were addressed (and pushed). */
	addressedThreads: string[];
	/** Threads that remain after the cycle. */
	pendingThreads: string[];
	/** Failures classified but not fixable by the autopilot. */
	blockedFailures: { name: string; cls: FailureClass; reason: string }[];
	/** Whether a push was performed this cycle. */
	pushed: boolean;
	/** The new head SHA after any push, or the unchanged head. */
	headSha: string;
}

/** Persisted across ticks so a later drive/watch resume does not re-handle work. */
export interface AutopilotPersistedState {
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

/** One cycle of the autopilot state machine's dependencies, for testability. */
export interface AutopilotDeps {
	gh: (args: string[], cwd: string) => Promise<ExecFnResult>;
}

/** Minimal exec result shared across the extension. */
export interface ExecFnResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Exec function signature, matching the pattern used by plan-implement's
 * delivery-mode: (command, args, options) => Promise<ExecFnResult>.
 */
export interface ExecFnOptions {
	cwd: string;
	timeout: number;
	/** Optional cancellation for long-running subprocesses. */
	signal?: AbortSignal;
}

export type ExecFn = (command: string, args: string[], options: ExecFnOptions) => Promise<ExecFnResult>;

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
	/** Drive mode: max fix/push cycles (watches do not count). */
	maxDriveCycles: 3,
	/** Watch mode: max fix/push cycles while waiting on GitHub. */
	maxWatchCycles: 15,
	/** Timeout for `gh pr checks --watch`. */
	watchTimeoutMinutes: 20,
} as const;

export type ThinkingLevel = "off" | "minimal" | "low";
