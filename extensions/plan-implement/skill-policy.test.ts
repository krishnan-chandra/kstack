import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARENA_SKILL_NAME, buildStackSkillPolicy, missingPublishSkills } from "./skill-policy.ts";

function skill(name: string, baseDir = `/skills/${name}`) {
	return { name, baseDir };
}

describe("buildStackSkillPolicy", () => {
	it("excludes arena, keeps every other skill, and re-adds them with --skill", () => {
		const result = buildStackSkillPolicy([
			skill("create-skill"),
			skill("arena"),
			skill("find-reviewers"),
			skill("write-pr"),
		]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.arenaExcluded, true);
		assert.deepEqual(
			result.skills.map((s) => s.name),
			["create-skill", "find-reviewers", "write-pr"],
		);
		assert.equal("skillArgs" in result, false);
		assert.equal("stackedPrsIncluded" in result, false);
	});

	it("succeeds when arena was never present (trivially excluded)", () => {
		const result = buildStackSkillPolicy([skill("create-skill"), skill("write-pr")]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.arenaExcluded, false);
	});

	it("does not require a deleted stacked-prs skill", () => {
		const result = buildStackSkillPolicy([skill("create-skill"), skill("arena")]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.skills.map((s) => s.name),
			["create-skill"],
		);
	});

	it("fails when arena survives the filter", () => {
		const result = buildStackSkillPolicy([skill("arena"), skill("write-pr")]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.ok(!result.skills.some((s) => s.name === ARENA_SKILL_NAME));
	});

	it("excludes arena by exact name only (a similarly named skill is kept)", () => {
		const result = buildStackSkillPolicy([skill("arena-extra"), skill("write-pr")]);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.ok(result.skills.some((s) => s.name === "arena-extra"));
	});

	it("missingPublishSkills requires both write-pr and find-reviewers", () => {
		assert.deepEqual(missingPublishSkills([skill("write-pr"), skill("find-reviewers")]), []);
		assert.deepEqual(missingPublishSkills([skill("write-pr")]), ["find-reviewers"]);
		assert.deepEqual(missingPublishSkills([]), ["write-pr", "find-reviewers"]);
		assert.deepEqual(missingPublishSkills([skill("write-pr-extra"), skill("arena")]), ["write-pr", "find-reviewers"]);
	});
});
