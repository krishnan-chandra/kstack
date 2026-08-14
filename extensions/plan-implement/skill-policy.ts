/** Stack-mode skill policy: exclude Arena, preserve everything else, require jj-stacked-prs. */

import type { SkillRef } from "./types.ts";

export const ARENA_SKILL_NAME = "arena";
export const STACKED_PRS_SKILL_NAME = "jj-stacked-prs";
const WRITE_PR_SKILL_NAME = "write-pr";
const FIND_REVIEWERS_SKILL_NAME = "find-reviewers";

interface SkillPolicyResult {
	ok: true;
	/** Skills to pass to children via repeated --skill (Arena excluded). */
	skills: SkillRef[];
	/** Arena was present in the discovered set and is excluded from the result. */
	arenaExcluded: boolean;
	/** jj-stacked-prs is present in the filtered set. */
	stackedPrsIncluded: boolean;
}

interface SkillPolicyError {
	ok: false;
	error: string;
}

/**
 * Build the stack-mode skill policy from the parent session's discovered
 * skills. Arena is excluded by name; every other skill is re-added with
 * `--no-skills --skill <dir>` so children keep task-specific skills without
 * the parallel-candidate fan-out that would corrupt a shared jj operation log.
 *
 * Returns an error when Arena cannot be proven excluded (it was present and
 * remains in the filtered set) or when jj-stacked-prs is not available.
 */
export function buildStackSkillPolicy(skills: SkillRef[]): SkillPolicyResult | SkillPolicyError {
	const arenaOriginallyPresent = skills.some((s) => s.name === ARENA_SKILL_NAME);
	const filtered = skills.filter((s) => s.name !== ARENA_SKILL_NAME);
	const arenaStillPresent = filtered.some((s) => s.name === ARENA_SKILL_NAME);
	if (arenaStillPresent) {
		return { ok: false, error: `Could not exclude the "${ARENA_SKILL_NAME}" skill from stack mode.` };
	}
	const stackedPrsIncluded = filtered.some((s) => s.name === STACKED_PRS_SKILL_NAME);
	if (!stackedPrsIncluded) {
		return {
			ok: false,
			error: `Stack mode requires the "${STACKED_PRS_SKILL_NAME}" skill to be discovered; it was not found in the session's skill set.`,
		};
	}
	return {
		ok: true,
		skills: filtered,
		arenaExcluded: arenaOriginallyPresent,
		stackedPrsIncluded,
	};
}

/** True when the discovered skills include a skill named `jj-stacked-prs`. */
export function hasStackedPrsSkill(skills: SkillRef[]): boolean {
	return skills.some((s) => s.name === STACKED_PRS_SKILL_NAME);
}

/**
 * The publish phase needs both `write-pr` (draft PR title/body) and
 * `find-reviewers` (reviewer recommendations). Both must be discovered skills
 * so the publisher child can consult them; in stack mode they are re-added
 * via --skill, in single mode the child discovers them itself.
 */
export function missingPublishSkills(skills: SkillRef[]): string[] {
	const names = new Set(skills.map((s) => s.name));
	return [WRITE_PR_SKILL_NAME, FIND_REVIEWERS_SKILL_NAME].filter((name) => !names.has(name));
}
