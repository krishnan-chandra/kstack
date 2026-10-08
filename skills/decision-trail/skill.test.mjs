import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));
const LOG_SH = resolve(skillDir, "scripts/log.sh");

test("decision-trail local markdown links resolve", async () => {
	const skill = await readFile(resolve(skillDir, "SKILL.md"), "utf8");
	for (const link of skill.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
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
