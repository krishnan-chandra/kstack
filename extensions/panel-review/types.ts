/**
 * Shared types for the panel-review extension.
 */

import type { ChildSession } from "../shared/child-agent-runner.ts";
import type { ModelSpec } from "../shared/model-spec.ts";

export interface ReviewerSpec extends ModelSpec {
	/** Run label ("A", "B", ...). Identifies runs only; not a persona. */
	label: string;
}

export interface PanelConfig {
	reviewers: ReviewerSpec[];
	maxConcurrency: number;
	/** Per-child idle limit in minutes; any child output resets the timer. */
	timeoutMinutes: number;
	/** Absolute per-child wall-clock ceiling in minutes. */
	maxRuntimeMinutes: number;
	/**
	 * Required model for the post-panel synthesis step. Synthesis merges
	 * bounded reviewer reports, so a small, fast model is usually the right
	 * choice.
	 */
	synthesis: Pick<ModelSpec, "model" | "thinking">;
}

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export type ReviewerResult =
	| { status: "completed"; label: string; model: string; output: string; usage: UsageSummary; session?: ChildSession }
	| {
			status: "failed";
			label: string;
			model: string;
			error: string;
			/** Partial progress at failure: turns, tokens, and cost observed before the child died. */
			usage?: UsageSummary;
			/** Last known child activity (e.g. "read bundle.md", "thinking"). */
			activity?: string;
			session?: ChildSession;
	  }
	| {
			status: "aborted";
			label: string;
			model: string;
			usage?: UsageSummary;
			activity?: string;
			session?: ChildSession;
	  };

export interface PanelArgs {
	base?: string;
	intent?: string;
	/** Internal callers may select another validated Git working tree. */
	repositoryPath?: string;
	/** Approved plan and implementer ledger supplied by plan-implement. */
	approvedPlan?: string;
	executionLedger?: string;
}

/**
 * Structured result of a panel-review run, returned through the in-process
 * API so callers (plan-implement) can chain follow-up phases. The slash
 * command ignores it.
 */
export type PanelReviewOutcome =
	| {
			status: "completed";
			/** Lead verdict, or raw reviewer reports when synthesis failed. */
			verdict: string;
			synthesized: boolean;
			baseSha: string;
			headSha: string;
	  }
	| { status: "no-changes" }
	| { status: "declined" }
	| { status: "aborted" }
	| { status: "failed"; error: string };

export type BaseStrategy = "explicit" | "upstream" | "remote-default" | "main" | "master" | "head";

export interface BaseResolution {
	/** Ref the user asked for (or the fallback ref that resolved). */
	ref: string;
	/** Immutable merge-base SHA every reviewer sees. */
	mergeBaseSha: string;
	strategy: BaseStrategy;
}

export interface ScopeBundle {
	/** Absolute path of the mode-0600 bundle file (outside the repo). */
	path: string;
	/** Temp directory containing the bundle; removed in finally. */
	dir: string;
	repoRoot: string;
	headSha: string;
	baseSha: string;
	baseRef: string;
	baseStrategy: BaseStrategy;
	fileCount: number;
	diffBytes: number;
	untrackedCount: number;
	binaryCount: number;
	truncated: boolean;
	/** True when the changeset touches AGENTS.md / CLAUDE.md / AGENTS.override.md. */
	contextFilesTouched: boolean;
	generatedAt: string;
}

export const LIMITS = {
	/** Total bundle budget. */
	bundleBytes: 2 * 1024 * 1024,
	/** Per untracked text file. */
	untrackedFileBytes: 256 * 1024,
	/** Max untracked files included in the bundle (status uses -uall). */
	untrackedFiles: 200,
	/** Final output per reviewer handed to the synthesizer. */
	reviewerOutputBytes: 24 * 1024,
	/** Aggregate reviewer input to the synthesizer. */
	synthesisInputBytes: 96 * 1024,
	/** Child stderr retention. */
	stderrBytes: 8 * 1024,
	/**
	 * Idle limit per child process (reviewers and synthesizer): any stdout/
	 * stderr output resets the timer, so slow-but-progressing children are
	 * not killed. A silent child is assumed stalled.
	 */
	reviewerTimeoutMs: 10 * 60 * 1000,
	/** Absolute wall-clock ceiling per child, regardless of activity. */
	reviewerMaxRuntimeMs: 30 * 60 * 1000,
	/** Rolling UTF-8 tail of live assistant text shown in the TUI dashboard. */
	livePreviewBytes: 240,
} as const;
