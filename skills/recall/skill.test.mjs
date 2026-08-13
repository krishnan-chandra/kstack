import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));
const skillPath = resolve(skillDir, "SKILL.md");

async function read(path) {
	return readFile(resolve(skillDir, path), "utf8");
}

test("recall is model-invocable and its local references resolve", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: recall\ndescription: .+/);
	assert.doesNotMatch(skill, /disable-model-invocation:/);

	for (const link of skill.matchAll(/\]\(([^)]+\.md)\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
});

test("recall mines through the archive tools on an allowlisted model", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /investigation-model\.mjs/);
	assert.match(skill, /search_session_archive/);
	assert.match(skill, /read_session_archive/);
	// Miners keep extensions enabled so the session-archive tools exist.
	assert.doesNotMatch(skill, /--no-extensions/);
});

test("recall is read-only and reconciles against live state", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /Read-only\./);
	assert.match(skill, /git status --short/);
	assert.match(skill, /gh pr list/);
	assert.match(skill, /live state wins/);
});
