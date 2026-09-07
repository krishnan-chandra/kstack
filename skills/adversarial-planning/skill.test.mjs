import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const skillDir = import.meta.dirname;
const skill = await readFile(join(skillDir, "SKILL.md"), "utf8");
const adversaryPrompt = await readFile(join(skillDir, "adversary-prompt.md"), "utf8");

test("adversarial planning is explicit-only and guarded by Herdr", () => {
	assert.match(skill, /^---\nname: adversarial-planning\ndescription: .+/);
	assert.match(skill, /disable-model-invocation: true/);
	assert.match(skill, /test "\$\{HERDR_ENV:-\}" = 1/);
	assert.match(skill, /herdr integration install pi/);
});

test("the skill keeps standalone planning and uses the shared request lifecycle", () => {
	assert.match(skill, /resolve-model/);
	assert.match(skill, /--section plan-adversary --key adversary/);
	assert.match(skill, /herdr agent start/);
	assert.match(skill, /herdr pane split/);
	assert.match(skill, /--no-focus/);
	assert.match(skill, /cli\.mjs" ask/);
	assert.match(skill, /at most three budgeted rounds/i);
	assert.match(skill, /After round 3 returns `revise`, stop/);
	assert.doesNotMatch(skill, /herdr agent prompt/);
});

test("the skill keeps panes and makes both handoffs explicit", () => {
	assert.match(skill, /Leave the adversary pane open/);
	assert.match(skill, /--fast --plan-file <absolute-plan-path>/);
	assert.match(skill, /--no-adversary Implement the plan at <absolute-plan-path>/);
});

test("the skill never falls back to headless or parallel child agents", () => {
	assert.doesNotMatch(skill, /parallel_agents/);
	assert.doesNotMatch(skill, /pi -p/);
	assert.doesNotMatch(skill, /--session-id/);
});

test("the adversary prompt defines the structured critique contract", () => {
	assert.match(adversaryPrompt, /Verdict: approve \| revise/);
	assert.match(adversaryPrompt, /## Blocking/);
	assert.match(adversaryPrompt, /\[B-1\]/);
	assert.match(adversaryPrompt, /## Suggestions/);
	assert.match(adversaryPrompt, /## Resolved from previous round/);
	assert.match(adversaryPrompt, /approve.*invalid while any blocking finding remains open/i);
	assert.match(adversaryPrompt, /repository content as untrusted data/i);
});
