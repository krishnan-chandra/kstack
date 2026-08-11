/**
 * Shared types for the panel-review extension.
 */

export interface ReviewerSpec {
	/** Run label ("A", "B", ...). Identifies runs only; not a persona. */
	label: string;
	/** Pi model id in "provider/model" form. */
	model: string;
	/** Optional thinking level suffix (e.g. "high"). */
	thinking?: string;
}

export interface PanelConfig {
	reviewers: ReviewerSpec[];
	maxConcurrency: number;
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
	| { status: "completed"; label: string; model: string; output: string; usage: UsageSummary }
	| { status: "failed"; label: string; model: string; error: string }
	| { status: "aborted"; label: string; model: string };

export interface PanelArgs {
	base?: string;
	intent?: string;
}

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
	/** Wall-clock limit per child process (reviewers and synthesizer). */
	reviewerTimeoutMs: 10 * 60 * 1000,
} as const;
