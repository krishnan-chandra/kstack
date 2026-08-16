import type { AutopilotConfirmation, AutopilotResult } from "../pr-autopilot/types.ts";
import type { MergeMethod } from "../shared/github.ts";
import type { LandConfirmation } from "./confirmation.ts";

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
	/**
	 * Capability minted by `issueLandConfirmation()`. A boolean or reconstructed
	 * object is not accepted. Skips only Land's interactive merge confirmation;
	 * every revalidation, head pin, and `--match-head-commit` check still runs.
	 */
	confirmation?: LandConfirmation;
	/** Separate authority for the readiness pass; Land forwards it unchanged to pr-autopilot. */
	autopilotConfirmation?: AutopilotConfirmation;
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
