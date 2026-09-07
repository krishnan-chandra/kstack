/** Shared types and limits for the plan/implement workflow. */
import type { ModelThinkingLevel } from "../shared/kstack-config.ts";

export type { ModelThinkingLevel };

/** How the approved plan is delivered. */
export type DeliveryMode = "single" | "stack";

/** Where single-PR implementation and follow-up phases run. */
export type WorkLocation = "current" | "worktree";

/** A discovered skill we may pass to a hosted agent with --skill. */
export interface SkillRef {
	/** Skill name (frontmatter `name`), used for Arena exclusion. */
	name: string;
	/** Skill directory, the path `--skill` accepts. */
	baseDir: string;
}

export interface RoleSpec {
	model: string;
	thinking?: ModelThinkingLevel;
}

export interface PlanImplementConfig {
	planner: RoleSpec;
	implementer: RoleSpec;
	timeoutMinutes: number;
}

export interface ResolvedRoles extends PlanImplementConfig {
	source: "config" | "default";
}

interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** Hosted roles in the plan → debate → implement → review-fix → publish loop. */
export type AgentRole = "planner" | "adversary" | "implementer" | "fixer" | "publisher";

export interface CritiqueFinding {
	id: string;
	text: string;
}

export interface ResolvedCritiqueFinding {
	id: string;
	summary: string;
}

export interface Critique {
	verdict: "approve" | "revise";
	blocking: CritiqueFinding[];
	suggestions: CritiqueFinding[];
	resolved: ResolvedCritiqueFinding[];
	raw: string;
}

export type CritiqueResult =
	| { status: "completed"; critique: Critique }
	| { status: "failed"; error: string }
	| { status: "aborted" };

export type AgentRunResult =
	| {
			status: "completed";
			role: AgentRole;
			model: string;
			output: string;
			usage: UsageSummary;
			session?: string;
			/** Execution-ledger section preserved for panel review, including omissions. */
			executionLedger?: string;
	  }
	| { status: "blocked"; role: AgentRole; model: string; paneId: string; session?: string }
	| { status: "failed"; role: AgentRole; model: string; error: string; session?: string }
	| { status: "aborted"; role: AgentRole; model: string; session?: string };

export const LIMITS = {
	taskBytes: 32 * 1024,
	plannerOutputBytes: 64 * 1024,
	critiqueOutputBytes: 32 * 1024,
	implementerOutputBytes: 32 * 1024,
	defaultTimeoutMinutes: 30,
	minTimeoutMinutes: 1,
	maxTimeoutMinutes: 60,
	panelIntentChars: 1000,
} as const;
