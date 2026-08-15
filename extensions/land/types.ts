import type { AutopilotResult } from "../pr-autopilot/driver.ts";

export type MergeMethod = "squash" | "rebase";
export type ReadinessMode = "check" | "watch";
interface LandTarget {
	kind: "single";
	prNumber: number;
}
export interface LandOptions {
	target: LandTarget;
	readiness: ReadinessMode;
	method?: MergeMethod;
	cwd?: string;
	/**
	 * Set by trusted in-process callers (for example `/jj-stack land`) that
	 * already obtained the user's consent for this exact PR. Skips only Land's
	 * interactive merge confirmation; every revalidation, head pin, and
	 * `--match-head-commit` check still runs.
	 */
	confirmedByCaller?: boolean;
}
export interface FrontierResult {
	prNumber: number;
	url: string;
	expectedHeadSha: string;
	method: MergeMethod;
	state: "landed" | "queued" | "blocked" | "not-attempted";
}
export interface LandResult {
	status: "landed" | "partially-landed" | "blocked" | "declined" | "aborted" | "failed";
	frontiers: FrontierResult[];
	autopilotRan: boolean;
	autopilotStatus?: AutopilotResult["status"];
	remainingBookmarks: string[];
	completedMutations: string[];
	recoveryOperationId?: string;
	blockers: string[];
}
export type { ExecFn, ExecFnResult as ExecResult } from "../shared/git-exec.ts";
export const LIMITS = {
	queryMs: 15_000,
	mergeMs: 60_000,
	pollMs: 10_000,
	landingMs: 30 * 60_000,
	diagnosticsBytes: 8 * 1024,
} as const;
