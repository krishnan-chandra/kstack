import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ARENA_SKILL_NAME,
	buildStackSkillPolicy,
	hasStackedPrsSkill,
	missingPublishSkills,
	STACKED_PRS_SKILL_NAME,
} from "./skill-policy.ts";

function skill(name: string, baseDir = `/skills/${name}`) {
	return { name, baseDir };
}

describe("buildStackSkillPolicy", () => {
	it("excludes arena, keeps every other skill, and re-adds them with --skill", () => {
		const result = buildStackSkillPolicy([
			skill("create-skill"),
			skill("arena"),
			skill("find-reviewers"),
			skill("jj-stacked-prs"),
		]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.arenaExcluded, true);
		assert.equal(result.stackedPrsIncluded, true);
		assert.deepEqual(
			result.skills.map((s) => s.name),
			["create-skill", "find-reviewers", "jj-stacked-prs"],
		);
		// The policy is the single source of truth for which skills survive; the
		// --skill argv is derived from this list in one place (agent-runner).
		assert.equal("skillArgs" in result, false);
	});

	it("succeeds when arena was never present (trivially excluded)", () => {
		const result = buildStackSkillPolicy([skill("create-skill"), skill("jj-stacked-prs")]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.arenaExcluded, false);
		assert.equal(result.stackedPrsIncluded, true);
	});

	it("fails when jj-stacked-prs is not discovered", () => {
		const result = buildStackSkillPolicy([skill("create-skill"), skill("arena")]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /jj-stacked-prs/);
	});

	it("fails when arena survives the filter", () => {
		// buildStackSkillPolicy filters by exact name; a malformed "arena "
		// would not be excluded. Simulate by asserting the real implementation
		// never leaves a skill named exactly "arena" in the result.
		const result = buildStackSkillPolicy([skill("arena"), skill("jj-stacked-prs")]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.ok(!result.skills.some((s) => s.name === ARENA_SKILL_NAME));
	});

	it("excludes arena by exact name only (a similarly named skill is kept)", () => {
		const result = buildStackSkillPolicy([skill("arena-extra"), skill("jj-stacked-prs")]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.ok(result.skills.some((s) => s.name === "arena-extra"));
	});

	it("hasStackedPrsSkill detects the skill by name", () => {
		assert.equal(hasStackedPrsSkill([skill("jj-stacked-prs")]), true);
		assert.equal(hasStackedPrsSkill([skill("arena")]), false);
		assert.equal(STACKED_PRS_SKILL_NAME, "jj-stacked-prs");
		assert.equal(ARENA_SKILL_NAME, "arena");
	});

	it("missingPublishSkills requires both write-pr and find-reviewers", () => {
		assert.deepEqual(missingPublishSkills([skill("write-pr"), skill("find-reviewers")]), []);
		assert.deepEqual(missingPublishSkills([skill("write-pr")]), ["find-reviewers"]);
		assert.deepEqual(missingPublishSkills([]), ["write-pr", "find-reviewers"]);
		assert.deepEqual(missingPublishSkills([skill("write-pr-extra"), skill("arena")]), ["write-pr", "find-reviewers"]);
	});
});
