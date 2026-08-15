import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARENA_SKILL_NAME, buildStackSkillPolicy, missingPublishSkills } from "./skill-policy.ts";

function skill(name: string, baseDir = `/skills/${name}`) {
	return { name, baseDir };
}

describe("buildStackSkillPolicy", () => {
	it("excludes Arena and preserves every other skill", () => {
		const result = buildStackSkillPolicy([
			skill("create-skill"),
			skill(ARENA_SKILL_NAME),
			skill("find-reviewers"),
			skill("write-pr"),
		]);
		assert.deepEqual(
			result.map((entry) => entry.name),
			["create-skill", "find-reviewers", "write-pr"],
		);
	});

	it("excludes Arena by exact name only", () => {
		const result = buildStackSkillPolicy([skill("arena-extra"), skill("write-pr")]);
		assert.deepEqual(
			result.map((entry) => entry.name),
			["arena-extra", "write-pr"],
		);
	});

	it("missingPublishSkills requires both write-pr and find-reviewers", () => {
		assert.deepEqual(missingPublishSkills([skill("write-pr"), skill("find-reviewers")]), []);
		assert.deepEqual(missingPublishSkills([skill("write-pr")]), ["find-reviewers"]);
		assert.deepEqual(missingPublishSkills([]), ["write-pr", "find-reviewers"]);
		assert.deepEqual(missingPublishSkills([skill("write-pr-extra"), skill("arena")]), ["write-pr", "find-reviewers"]);
	});
});
