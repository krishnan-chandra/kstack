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

test("reflect is model-invocable and its local references resolve", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: reflect\ndescription: .+/);
	assert.doesNotMatch(skill, /disable-model-invocation:/);

	for (const link of skill.matchAll(/\]\(([^)]+\.md)\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
});

test("headless reviewer fallback has an enforced read-only boundary", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /--no-session --no-extensions --no-skills --no-context-files/);
	assert.match(skill, /--tools read,grep,find,ls/);
	assert.match(skill, /Do not rely on a reviewer prompt to prevent writes/);
});

test("reviewer templates permit an evidence-backed empty result", async () => {
	for (const template of [
		"references/judgment-reviewer.md",
		"references/tooling-reviewer.md",
		"references/divergent-reviewer.md",
	]) {
		const contents = await read(template);
		assert.match(contents, /Return up to five findings/);
		assert.match(contents, /No durable findings\./);
		assert.doesNotMatch(contents, /3[–-]5 findings/);
	}
});
