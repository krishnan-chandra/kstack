/**
 * Shared types for the pr-babysit extension.
 *
 * The PR babysitter is a bounded, tiny-model-only workflow: it owns a single
 * PR frontier at a time (the lowest unmerged PR), classifies its state with
 * small child agents, addresses review threads and CI failures it can fix,
 * pushes, and re-checks — stopping at merge-ready. It never auto-merges, never
 * re-stacks shared history, and never uses anything other than the tiny models
 * recorded in kstack.json.
 */

/** Babysit modes — the explicit user-facing entry points. */
export type BabysitMode = "check" | "threads" | "drive" | "cleanup";

/** Tiny-model child roles inside the babysit loop. */
export type BabysitAgentRole = "triager" | "fixer";

/** A model entry in the pr-babysit config, with a short run label. */
export interface BabysitModelSpec {
	/** Short run label (e.g. "luna", "flash"). */
	label: string;
	/** Pi model id in "provider/model" form. */
	model: string;
	/** Thinking level for the child; default "low" for tiny models. */
	thinking?: string;
}

/** Resolved pr-babysit configuration after availability checking. */
export interface ResolvedBabysitConfig {
	models: BabysitModelSpec[];
	maxConcurrency: number;
	timeoutMinutes: number;
	maxRuntimeMinutes: number;
	source: "config" | "default";
	warnings: string[];
}

/** A GitHub check run / CI job as surfaced by `gh pr view`. */
export interface CheckRun {
	name: string;
	status: "success" | "failure" | "pending" | "neutral" | "skipped";
	conclusion: "success" | "failure" | "pending" | "neutral" | "skipped" | null;
}

/** A review thread extracted from the GitHub PR API. */
export interface ReviewThread {
	id: string;
	commenter: string;
	body: string;
	status: "COMMENTED" | "RESOLVED" | "DISMISSED";
	path?: string;
	line?: number;
}

/**
 * A check-run classification produced by the tiny-model triager: tells the
 * babysitter whether a failure is the diff's own code, a stale base, or
 * infrastructure flakiness — before any retrigger is attempted.
 */
export type FailureClass = "code" | "stale-base" | "flake" | "infra" | "unknown";

/** Classification of a single review thread. */
export interface ThreadClassification {
	threadId: string;
	failureClass: FailureClass;
	/** Human-readable one-line summary of what to do with this thread. */
	action: string;
	/** Whether the thread can be addressed by a generated code change. */
	fixable: boolean;
}

/** Complete PR state snapshot that drives a babysit decision. */
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
	checks: CheckRun[];
	threads: ReviewThread[];
	/** Whether the PR is blocked by unaddressed review threads. */
	hasUnresolvedThreads: boolean;
}

/**
 * Outcome of one babysit cycle iteration. The state machine keys off this to
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
	/** Failures classified but not fixable by the babysitter. */
	blockedFailures: { name: string; cls: FailureClass; reason: string }[];
	/** Whether a push was performed this cycle. */
	pushed: boolean;
	/** The new head SHA after any push, or the unchanged head. */
	headSha: string;
}

/** Lifecycle token to guard against overlapping babysit runs. */
export interface BabysitToken {
	readonly generation: number;
}

/** One cycle of the babysit state machine's dependencies, for testability. */
export interface BabysitDeps {
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
}

export type ExecFn = (command: string, args: string[], options: ExecFnOptions) => Promise<ExecFnResult>;

/** Config guardrails the babysitter enforces to stay "tiny-model-only". */
export const LIMITS = {
	/** Maximum PRs traversed in the frontier sweep (always pick the lowest). */
	maxFrontierPRs: 5,
	/** BabysitMode default timeout (minutes) applied to tiny child agents. */
	defaultTimeoutMinutes: 5,
	minTimeoutMinutes: 1,
	maxTimeoutMinutes: 15,
	/** Default absolute runtime ceiling for a child agent (minutes). */
	defaultMaxRuntimeMinutes: 15,
	minRuntimeMinutes: 2,
	maxRuntimeMinutes: 60,
	/** Max concurrent tiny-model children. */
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
} as const;

export type ThinkingLevel = "off" | "minimal" | "low";
