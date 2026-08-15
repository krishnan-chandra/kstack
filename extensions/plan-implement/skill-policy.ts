/** Stack-mode skill policy: exclude Arena and preserve every other discovered skill. */

import type { SkillRef } from "./types.ts";

export const ARENA_SKILL_NAME = "arena";
const WRITE_PR_SKILL_NAME = "write-pr";
const FIND_REVIEWERS_SKILL_NAME = "find-reviewers";

/**
 * Exclude Arena from stack-mode children because parallel candidates would
 * mutate the same jj operation log. Preserve every other discovered skill.
 */
export function buildStackSkillPolicy(skills: SkillRef[]): SkillRef[] {
	return skills.filter((skill) => skill.name !== ARENA_SKILL_NAME);
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
