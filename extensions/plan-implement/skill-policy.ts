/** Stack-mode skill policy: exclude Arena and preserve every other discovered skill. */

import type { SkillRef } from "./types.ts";

export const ARENA_SKILL_NAME = "arena";
const WRITE_PR_SKILL_NAME = "write-pr";
const FIND_REVIEWERS_SKILL_NAME = "find-reviewers";

interface SkillPolicyResult {
	ok: true;
	/** Skills to pass to children via repeated --skill (Arena excluded). */
	skills: SkillRef[];
	/** Arena was present in the discovered set and is excluded from the result. */
	arenaExcluded: boolean;
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
 * remains in the filtered set).
 */
export function buildStackSkillPolicy(skills: SkillRef[]): SkillPolicyResult | SkillPolicyError {
	const arenaOriginallyPresent = skills.some((s) => s.name === ARENA_SKILL_NAME);
	const filtered = skills.filter((s) => s.name !== ARENA_SKILL_NAME);
	const arenaStillPresent = filtered.some((s) => s.name === ARENA_SKILL_NAME);
	if (arenaStillPresent) {
		return { ok: false, error: `Could not exclude the "${ARENA_SKILL_NAME}" skill from stack mode.` };
	}
	return {
		ok: true,
		skills: filtered,
		arenaExcluded: arenaOriginallyPresent,
	};
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
