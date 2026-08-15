import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ChangeKind } from "../shared/change-kind.ts";

export const LIMITS = {
	maxTaskBytes: 32 * 1024,
	defaultTimeoutMinutes: 30,
	minTimeoutMinutes: 1,
	maxTimeoutMinutes: 60,
	outputBytes: 32 * 1024,
	stderrBytes: 8 * 1024,
	stdoutLineBytes: 2 * 1024 * 1024,
	killGraceMs: 5_000,
} as const;

export interface RoleSpec {
	model: string;
	thinking?: ThinkingLevel;
}
export interface FastImplementConfig {
	implementer: RoleSpec;
	timeoutMinutes: number;
}
export interface ResolvedRole extends FastImplementConfig {
	source: "config" | "default";
}
export interface FastImplementRequest {
	task: string;
	workLocation: "current" | "worktree";
	changeKind: ChangeKind;
}
export type FastImplementOutcome =
	| { status: "completed"; branch: string; cwd: string; output: string }
	| { status: "failed" | "aborted"; error: string; branch?: string; cwd?: string; output?: string };
