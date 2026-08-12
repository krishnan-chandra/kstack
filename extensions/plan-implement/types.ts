/** Shared types and limits for the plan/implement workflow. */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RoleSpec {
	model: string;
	thinking?: ThinkingLevel;
}

export interface PlanImplementConfig {
	planner: RoleSpec;
	implementer: RoleSpec;
	timeoutMinutes: number;
}

export interface ResolvedRoles extends PlanImplementConfig {
	source: "config" | "default";
}

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export type AgentRunResult =
	| { status: "completed"; role: "planner" | "implementer"; model: string; output: string; usage: UsageSummary }
	| { status: "failed"; role: "planner" | "implementer"; model: string; error: string }
	| { status: "aborted"; role: "planner" | "implementer"; model: string };

export const LIMITS = {
	taskBytes: 32 * 1024,
	plannerOutputBytes: 64 * 1024,
	implementerOutputBytes: 32 * 1024,
	stderrBytes: 8 * 1024,
	stdoutLineBytes: 2 * 1024 * 1024,
	defaultTimeoutMinutes: 30,
	minTimeoutMinutes: 1,
	maxTimeoutMinutes: 60,
	killGraceMs: 5000,
	panelIntentChars: 1000,
} as const;
