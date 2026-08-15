import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
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

test("recall enforces a read-only tool boundary on miners", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /investigation-model\.mjs/);
	// The allowlist is the enforcement, not the prompt: built-in read-only
	// tools plus the two read-only archive tools, and nothing else.
	assert.match(skill, /--tools read,grep,find,ls,search_session_archive,read_session_archive/);
	// Miners keep extensions enabled so the session-archive tools exist.
	assert.doesNotMatch(skill, /--no-extensions/);
	// No shell-based searching; bash stays out of the allowlist.
	assert.doesNotMatch(skill, /with rg\b/);
});

test("recall separates active-session reading from archive reads", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /Never pass an\s+active session id to read_session_archive/);
	assert.match(skill, /read the JSONL files directly/);
});

test("recall keeps user-controlled scope out of shell source", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /\bwrite\b.*\btool\b/i);
	assert.match(skill, /@"\$PROMPT_FILE"/);
	assert.doesNotMatch(skill, /--model "\$MODEL" "/);
});

test("recall is read-only and reconciles against live state", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /Read-only\./);
	assert.match(skill, /git status --short/);
	assert.match(skill, /gh pr list/);
	assert.match(skill, /live state wins/);
});
