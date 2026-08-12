import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));

async function read(path) {
	return readFile(resolve(skillDir, path), "utf8");
}

test("architect is explicit-only and all local markdown links resolve", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: architect\ndescription: .+/);
	assert.match(skill, /disable-model-invocation: true/);

	for (const link of skill.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
});

test("architect preserves the caller-first multi-design contract", async () => {
	const skill = await read("SKILL.md");
	const runner = await read("references/runner-prompt.md");
	const rationale = await read("references/rationale-template.md");

	assert.match(skill, /at least two \*\*structurally distinct\*\* viable candidates/);
	assert.match(skill, /Run \[?`?arena/);
	assert.match(skill, /Use \[?`?how/);
	assert.match(skill, /repeated pattern/);
	assert.match(runner, /Start with the caller/);
	assert.match(runner, /Do not edit production files/);
	assert.match(rationale, /## Usage \(caller's view\)/);
	assert.match(rationale, /## Synthesis decision/);
	assert.match(rationale, /## Alternatives considered/);
});

test("Arena candidates receive self-contained architect instructions", async () => {
	const skill = await read("SKILL.md");
	const runner = await read("references/runner-prompt.md");

	assert.match(skill, /Inline the full contents of all three files/);
	assert.match(skill, /Do not pass relative reference paths/);
	assert.match(runner, /Everything needed to produce the design is in the task/);
	assert.doesNotMatch(runner, /Read the architect skill/);
});

test("Pi adaptation does not depend on unavailable pstack workflows", async () => {
	const files = [
		await read("SKILL.md"),
		await read("references/runner-prompt.md"),
		await read("references/rationale-template.md"),
		await read("../arena/SKILL.md"),
	];
	const combined = files.join("\n");

	assert.doesNotMatch(combined, /\binterrogate\b/i);
	assert.doesNotMatch(combined, /\btodolist\b/i);
	assert.doesNotMatch(combined, /principle skill/i);
});
