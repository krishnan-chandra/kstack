import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");

test("Swarm uses Herdr cli fanout for parallel workers", () => {
	assert.match(skill, /HERDR_ENV/);
	assert.match(skill, /extensions\/shared\/herdr\/cli\.mjs/);
	assert.match(skill, /fanout/);
	assert.match(skill, /watch workers in the `swarm: <run-id>` tab/i);
	assert.doesNotMatch(skill, /parallel_agents/);
	assert.doesNotMatch(skill, /subagent\(\{/);
	assert.doesNotMatch(skill, /pi -p --no-session/);
});
