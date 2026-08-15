/** Shared types and limits for the plan/implement workflow. */
import type { ThinkingLevel } from "../shared/kstack-config.ts";

export type { ThinkingLevel };

/** How the approved plan is delivered. */
export type DeliveryMode = "single" | "stack";

/** Where single-PR implementation and follow-up phases run. */
export type WorkLocation = "current" | "worktree";

/** A discovered skill we may pass to a child via --skill. */
export interface SkillRef {
	/** Skill name (frontmatter `name`), used for Arena exclusion. */
	name: string;
	/** Skill directory, the path `--skill` accepts. */
	baseDir: string;
}

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

/** Child roles in the plan → implement → review-fix → publish loop. */
export type AgentRole = "planner" | "implementer" | "fixer" | "publisher";

export type AgentRunResult =
	| {
			status: "completed";
			role: AgentRole;
			model: string;
			output: string;
			usage: UsageSummary;
			/** Execution-ledger section preserved for panel review, including omissions. */
			executionLedger?: string;
	  }
	| { status: "failed"; role: AgentRole; model: string; error: string }
	| { status: "aborted"; role: AgentRole; model: string };

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
