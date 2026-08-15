import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));
const LOG_SH = resolve(skillDir, "scripts/log.sh");

async function read(path) {
	return readFile(resolve(skillDir, path), "utf8");
}

test("decision-trail is explicit-only and all local markdown links resolve", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: decision-trail\ndescription: .+/);
	assert.match(skill, /disable-model-invocation: true/);

	for (const link of skill.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
});

test("decision-trail preserves the TSV contract and opt-in posture", async () => {
	const skill = await read("SKILL.md");
	const template = await read("references/decision-log-template.tsv");

	assert.equal(template, "ts\tphase\tdecision\twhy\tevidence\tresult\n");
	assert.match(skill, /opt-in/i);
	assert.match(skill, /Append-only/);
	assert.match(skill, /pointer, not prose/);
	// Pairs with kstack's session infrastructure rather than globbing transcripts.
	assert.match(skill, /\$PI_SESSION_FILE/);
	assert.match(skill, /read_handoff_history/);
	assert.match(skill, /read_session_archive/);
	assert.match(skill, /Do not scan other session directories/);
});

test("cross-model review resolves a model from the shared investigation allowlist", async () => {
	const skill = await read("SKILL.md");
	const reflect = await read("../reflect/SKILL.md");

	assert.match(skill, /node \.\.\/investigation-model\.mjs/);
	assert.match(skill, /investigation\.allowedModels/);
	assert.match(skill, /Never bypass/);
	assert.doesNotMatch(skill, /--model <provider\/model/);
	assert.match(skill, /--no-extensions --no-skills --no-context-files/);
	assert.match(skill, /--tools read,grep,find,ls/);
	assert.match(skill, /reviewed by <model>/);
	// Same boundary convention as reflect: allowlist, not prompt promises.
	assert.match(reflect, /--tools read,grep,find,ls/);
});

test("Pi adaptation does not depend on unavailable pstack mechanisms", async () => {
	const skill = await read("SKILL.md");

	assert.doesNotMatch(skill, /agent-transcripts/);
	assert.doesNotMatch(skill, /cursor/i);
	assert.doesNotMatch(skill, /subagent_type/);
	assert.doesNotMatch(skill, /principle skill/i);
});

async function runLog(logfile, ...cells) {
	return execFileSync("bash", [LOG_SH, logfile, ...cells], { encoding: "utf8" });
}

test("log.sh writes the header once and appends sanitized rows", async () => {
	const dir = await mkdtemp(join(tmpdir(), "decision-trail-"));
	const logfile = join(dir, "decisions.tsv");

	await runLog(logfile, "frame", "chose two-phase archive", "keeps one complete copy", "commit abc1234", "tests green");
	await runLog(logfile, "pr1", "rejected\tcopy-first\napproach", "crash window", "=cmd|evil", "superseded");

	const lines = (await readFile(logfile, "utf8")).split("\n").filter(Boolean);
	assert.equal(lines.length, 3);
	assert.equal(lines[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
	for (const line of lines.slice(1)) {
		assert.equal(line.split("\t").length, 6, `row must have 6 cells: ${line}`);
		assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\t/);
	}
	// Embedded tabs/newlines are flattened to spaces; formula cells are quoted.
	assert.match(lines[2], /rejected copy-first approach/);
	assert.match(lines[2], /'=cmd\|evil/);
});

test("audit corrections preserve the append-only invariant", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /no audit exception/);
	assert.match(skill, /superseding it; never edit or delete the original/i);
	assert.doesNotMatch(skill, /Cut invented/);
	assert.doesNotMatch(skill, /Drop padding/);
});

test("log.sh writes the header into an existing empty logfile", async () => {
	const dir = await mkdtemp(join(tmpdir(), "decision-trail-"));
	const logfile = join(dir, "decisions.tsv");
	await execFileSync("touch", [logfile]);

	await runLog(logfile, "phase", "decision", "why", "evidence", "result");

	const lines = (await readFile(logfile, "utf8")).split("\n").filter(Boolean);
	assert.equal(lines[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
	assert.equal(lines.length, 2);
});

test("log.sh creates missing parent directories and rejects bad arity", async () => {
	const dir = await mkdtemp(join(tmpdir(), "decision-trail-"));
	const nested = join(dir, ".audit", "task-slug.tsv");
	await runLog(nested, "phase", "decision", "why", "evidence", "result");
	await access(nested);

	assert.throws(() => execFileSync("bash", [LOG_SH, "x.tsv", "too", "few"], { stdio: "pipe" }));
});
