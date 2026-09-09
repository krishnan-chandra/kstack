import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");

test("Simplify uses Kstack child agents for parallel lenses", () => {
	assert.match(skill, /one `parallel_agents` tool call/);
	assert.match(skill, /same child-agent runner and shared live pane used by panel review/);
	assert.match(skill, /read-only by construction/);
	assert.match(skill, /read\/grep\/find\/ls-only/);
	assert.match(skill, /persisted subagent sessions/);
	assert.match(skill, /continue with the completed reports and name the missing lens/);
	assert.doesNotMatch(skill, /HERDR_ENV/);
	assert.doesNotMatch(skill, /extensions\/shared\/herdr\/cli\.mjs/);
});
