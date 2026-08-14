import type { AutopilotResult } from "../pr-autopilot/driver.ts";

export type MergeMethod = "merge" | "squash" | "rebase";
export type ReadinessMode = "check" | "watch";
export interface LandTarget { kind: "single"; prNumber: number }
export interface LandOptions { target: LandTarget; readiness: ReadinessMode; method?: MergeMethod; cwd?: string }
export interface FrontierResult {
	prNumber: number; url: string; expectedHeadSha: string; method: MergeMethod;
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
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions { cwd: string; timeout: number; signal?: AbortSignal }
export type ExecFn = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;
export const LIMITS = { queryMs: 15_000, mergeMs: 60_000, pollMs: 10_000, landingMs: 30 * 60_000, diagnosticsBytes: 8 * 1024 } as const;
