import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("./SKILL.md", import.meta.url), "utf8");

test("Simplify requires the dashboard-backed parallel agent tool", () => {
	assert.match(skill, /one `parallel_agents` tool call/);
	assert.match(skill, /kind: "simplify"/);
	assert.match(skill, /read\/grep\/find\/ls-only isolation/);
	assert.match(skill, /Do not replace it with background `pi` commands or a silent shell `wait`/);
	assert.match(skill, /continue with the completed reports and name the missing lens/);
});
