import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");

test("Arena uses Herdr cli fanout for fan-out and judging", () => {
	assert.match(skill, /HERDR_ENV/);
	assert.match(skill, /extensions\/shared\/herdr\/cli\.mjs/);
	assert.match(skill, /fanout/);
	assert.match(skill, /second `cli\.mjs fanout` call/);
	assert.match(skill, /distinct pre-created candidate worktree or directory/);
	assert.match(skill, /watch candidates in the `arena: <label>` tab|watch candidates in the `arena: <run-id>` tab/i);
	assert.match(skill, /steer a candidate by prompting its pane/);
	assert.doesNotMatch(skill, /parallel_agents/);
	assert.doesNotMatch(skill, /Ctrl\+Shift\+V/);
	assert.doesNotMatch(skill, /Ctrl\+Shift\+X/);
});
