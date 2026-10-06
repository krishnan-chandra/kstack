import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));

async function read(path) {
	return readFile(resolve(skillDir, path), "utf8");
}

test("bro is explicit-only and restates the last message plainly", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: bro\ndescription: .+/);
	assert.match(skill, /disable-model-invocation: true/);
	assert.match(skill, /Restate your last message/);
	assert.match(skill, /no jargon/i);
});

test("Pi adaptation does not depend on unavailable pstack mechanisms", async () => {
	const skill = await read("SKILL.md");

	assert.doesNotMatch(skill, /agent-transcripts/);
	assert.doesNotMatch(skill, /\bsubagent_type\b/);
	assert.doesNotMatch(skill, /principle skill/i);
});
