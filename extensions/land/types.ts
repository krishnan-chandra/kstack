import type { AutopilotResult } from "../pr-autopilot/types.ts";
import type { MergeMethod } from "../shared/github.ts";

export type { MergeMethod } from "../shared/github.ts";
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
}
export interface FrontierResult {
	prNumber: number;
	url: string;
	expectedHeadSha: string;
	method: MergeMethod | "graphite";
	state: "landed" | "queued" | "blocked" | "not-attempted";
}
export interface LandResult {
	status: "landed" | "partially-landed" | "indeterminate" | "blocked" | "declined" | "aborted" | "failed";
	frontiers: FrontierResult[];
	autopilotRan: boolean;
	autopilotStatus?: AutopilotResult["status"];
	remainingRefs: string[];
	completedMutations: string[];
	/** Non-fatal problems that occurred after the primary outcome was established. */
	warnings?: string[];
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
