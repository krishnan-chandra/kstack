import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");

test("Arena uses the dashboard-backed parallel agent tool for fan-out and judging", () => {
	assert.match(skill, /one `parallel_agents` tool call with `kind: "arena"`/);
	assert.match(skill, /second `parallel_agents` call/);
	assert.match(skill, /distinct pre-created candidate worktree or directory/);
	assert.match(skill, /Do not replace it with background `pi` commands or a silent shell `wait`/);
	assert.match(skill, /Ctrl\+Shift\+V/);
	assert.match(skill, /Ctrl\+Shift\+X/);
	assert.match(skill, /fresh live pane with no fan-out transcript state/);
});
