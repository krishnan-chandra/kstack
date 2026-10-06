import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));

async function read(path) {
	return readFile(resolve(skillDir, path), "utf8");
}

test("teach is explicit-only and composes how, why, and unslop", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: teach\ndescription: .+/);
	assert.match(skill, /disable-model-invocation: true/);
	assert.match(skill, /Teach sits on top of `how` and `why`/);
	assert.match(skill, /through the \*\*unslop\*\* skill/);
	assert.match(skill, /Keep `why`'s confidence language intact/);

	for (const sibling of ["../how/SKILL.md", "../why/SKILL.md", "../unslop/SKILL.md"]) {
		await access(resolve(skillDir, sibling));
	}
});

test("teach preserves the conversational teaching contract", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /Run them in parallel/);
	assert.match(skill, /diagram by diagram/);
	assert.match(skill, /never a report about what you did/i);
	assert.match(skill, /Don't print "Pause"/);
});

test("Pi adaptation does not depend on unavailable pstack mechanisms", async () => {
	const skill = await read("SKILL.md");

	assert.doesNotMatch(skill, /agent-transcripts/);
	assert.doesNotMatch(skill, /\bsubagent_type\b/);
	assert.doesNotMatch(skill, /principle skill/i);
	assert.doesNotMatch(skill, /\binterrogate\b/i);
});
