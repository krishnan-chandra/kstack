import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));

async function read(path) {
	return readFile(resolve(skillDir, path), "utf8");
}

test("setup-kstack is model-invocable and its local markdown links resolve", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: setup-kstack\ndescription: .+/);
	assert.doesNotMatch(skill, /disable-model-invocation:/);

	for (const link of skill.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
});

test("setup-kstack discovers, validates, previews, and safely writes user config", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /pi --list-models/);
	assert.match(skill, /pi auth check --model <provider\/model> --json/);
	assert.match(skill, /explicit approval/i);
	assert.match(skill, /unified diff/i);
	assert.match(skill, /temporary file/i);
	assert.match(skill, /Rename the temporary file over `kstack\.json`/);
	assert.match(skill, /Do not update `kstack\.example\.json`/);
	assert.match(skill, /preserves?\s+unknown top-level sections/i);
});

test("setup-kstack covers every unified configuration section and its critical invariants", async () => {
	const skill = await read("SKILL.md");

	for (const section of ["vcs", "plan-implement", "panel-review", "kstack-router", "investigation", "arena", "swarm"]) {
		assert.match(skill, new RegExp(`\\\\| \`${section}\``));
	}
	assert.match(skill, /planner and implementer use different model IDs/);
	assert.match(skill, /jj workspace root/);
	assert.match(skill, /Git mode refuses a jj-managed workspace/);
	assert.match(skill, /gt --no-interactive trunk/);
	assert.match(skill, /gt >= 1\.8\.5/);
	assert.match(skill, /2–5/);
	assert.match(skill, /cross-judge from a different model family/i);
	assert.match(skill, /at least `medium` thinking/);
});
