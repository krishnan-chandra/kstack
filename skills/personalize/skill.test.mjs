import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));
const EXTRACT = resolve(skillDir, "scripts/extract_sessions.py");

async function read(path) {
	return readFile(resolve(skillDir, path), "utf8");
}

test("personalize conforms to the Agent Skills format and links resolve", async () => {
	const skill = await read("SKILL.md");

	assert.match(skill, /^---\nname: personalize\ndescription: .{50,}/);
	const frontmatter = skill.split("---")[1];
	const description = frontmatter.match(/description: (.+)/)[1];
	assert.ok(description.length <= 1024, "description fits the 1024-char spec limit");
	assert.match(frontmatter, /license: MIT/);
	assert.doesNotMatch(frontmatter, /disable-model-invocation/, "model-invocable like reflect");

	for (const link of skill.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
});

test("personalize keeps the safety contract: read-only, untrusted input, approval gate", async () => {
	const skill = await read("SKILL.md");
	const script = await read("scripts/extract_sessions.py");

	assert.match(skill, /untrusted data/);
	assert.match(skill, /never\s+upload/i);
	assert.match(skill, /approves the exact proposed edits/i);
	assert.match(script, /query_only/);
	assert.doesNotMatch(script, /requests|urllib|http\.client/, "extractor must not touch the network");
});

async function makeFixture() {
	const dir = await mkdtemp(join(tmpdir(), "personalize-test-"));
	const pi = join(dir, "pi");
	const claude = join(dir, "claude");
	const codex = join(dir, "codex");
	const cursor = join(dir, "cursor");
	await mkdir(pi, { recursive: true });
	await mkdir(claude, { recursive: true });
	await mkdir(codex, { recursive: true });
	await mkdir(cursor, { recursive: true });

	await writeFile(
		join(pi, "2026-08-01T00-00-00-000Z_019ff000-0000-7000-8000-000000000001.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "pi-1", timestamp: "2026-08-01T00:00:00Z", cwd: "/x" }),
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-01T00:00:01Z",
				message: { role: "user", content: [{ type: "text", text: "never commit without asking" }], timestamp: 0 },
			}),
			JSON.stringify({
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-08-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden" },
						{ type: "text", text: "understood" },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "t1",
				parentId: "a1",
				timestamp: "2026-08-01T00:00:03Z",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "noise" }],
					isError: false,
				},
			}),
		].join("\n") + "\n",
	);

	await mkdir(join(claude, "session-1", "subagents"), { recursive: true });
	await writeFile(
		join(claude, "session-1", "subagents", "agent-x.jsonl"),
		JSON.stringify({
			type: "user",
			sessionId: "agent-x",
			timestamp: "2026-08-02T00:00:03Z",
			message: { role: "user", content: "delegation prompt written by the agent" },
		}) + "\n",
	);

	await writeFile(
		join(claude, "session-1.jsonl"),
		[
			JSON.stringify({ type: "mode", mode: "normal", sessionId: "claude-1" }),
			JSON.stringify({
				type: "user",
				sessionId: "claude-1",
				timestamp: "2026-08-02T00:00:01Z",
				message: { role: "user", content: "always run tests before committing" },
			}),
			JSON.stringify({
				type: "assistant",
				sessionId: "claude-1",
				timestamp: "2026-08-02T00:00:02Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "will do" },
						{ type: "tool_use", name: "bash", input: {} },
					],
				},
			}),
		].join("\n") + "\n",
	);

	await writeFile(
		join(codex, "rollout-2026-08-03T00-00-00-abc.jsonl"),
		[
			JSON.stringify({
				timestamp: "2026-08-03T00:00:01Z",
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "we use jj in this repo" }] },
			}),
			JSON.stringify({
				timestamp: "2026-08-03T00:00:02Z",
				type: "event_msg",
				payload: { type: "agent_message", message: "noted" },
			}),
		].join("\n") + "\n",
	);

	const cursorDb = join(cursor, "state_test.sqlite");
	execFileSync("sqlite3", [cursorDb, "CREATE TABLE cursorDiskKV (key TEXT, value TEXT);"]);
	execFileSync("sqlite3", [
		cursorDb,
		`INSERT INTO cursorDiskKV VALUES ('aiService.prompts', '${JSON.stringify({ prompts: [{ text: "prefer small diffs please" }] }).replace(/'/g, "''")}');`,
	]);
	// A hostile table name must not break identifier quoting or exfiltrate other tables.
	const bait = JSON.stringify({ text: "bait value from hostile table" });
	execFileSync("python3", [
		"-c",
		`import sqlite3; c = sqlite3.connect(${JSON.stringify(cursorDb)}); c.execute('CREATE TABLE "evil""name" (value TEXT)'); c.execute('INSERT INTO "evil""name" VALUES (?)', (${JSON.stringify(bait)},)); c.commit(); c.close()`,
	]);

	return {
		dir,
		env: {
			PERSONALIZE_PI_HOME: pi,
			PERSONALIZE_CLAUDE_HOME: claude,
			PERSONALIZE_CODEX_HOME: codex,
			PERSONALIZE_CURSOR_HOME: cursor,
		},
	};
}

function runExtract(env, ...args) {
	const out = execFileSync("python3", [EXTRACT, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	return out.trim()
		? out
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}

test("extractor normalizes user turns from all four agents", async () => {
	const { dir, env } = await makeFixture();
	try {
		const records = runExtract(env, "--source", "all", "--roles", "user,unknown");
		const bySource = new Map();
		for (const r of records) if (!bySource.has(r.source)) bySource.set(r.source, r);

		assert.equal(bySource.get("pi")?.text, "never commit without asking");
		assert.equal(bySource.get("pi")?.session_id, "pi-1");
		assert.equal(bySource.get("claude")?.text, "always run tests before committing");
		assert.equal(bySource.get("claude")?.session_id, "claude-1");
		assert.equal(bySource.get("codex")?.text, "we use jj in this repo");
		assert.match(bySource.get("cursor")?.text ?? "", /prefer small diffs/);
		for (const record of records) assert.ok(["user", "unknown"].includes(record.role));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractor excludes Claude subagent transcripts and Cursor unknown roles by default", async () => {
	const { dir, env } = await makeFixture();
	try {
		const records = runExtract(env, "--source", "all", "--roles", "user");
		assert.ok(
			records.every((r) => r.role === "user"),
			"no unknown-role Cursor records in a user-only run",
		);
		assert.ok(
			records.some((r) => r.source === "cursor" && r.text.includes("prefer small diffs")),
			"aiService.prompts rows count as user turns in a default run",
		);
		assert.ok(!records.some((r) => r.text.includes("delegation prompt")), "subagent transcripts excluded");

		const withSubagents = runExtract(env, "--source", "claude", "--include-subagents");
		assert.ok(
			withSubagents.some((r) => r.text.includes("delegation prompt")),
			"explicit opt-in includes subagents",
		);

		const withUnknown = runExtract(env, "--source", "cursor", "--roles", "unknown");
		assert.ok(withUnknown.length > 0, "unknown role is an explicit opt-in");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractor quotes hostile SQLite identifiers instead of injecting", async () => {
	const { dir, env } = await makeFixture();
	try {
		const records = runExtract(env, "--source", "cursor", "--roles", "unknown");
		assert.ok(
			records.some((r) => r.text.includes("bait value from hostile table")),
			"hostile table is read safely, not executed",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractor filters --cwd against the session's recorded cwd, not the file path", async () => {
	const { dir, env } = await makeFixture();
	try {
		// Pi header cwd is /x; the fixture file path contains 'pi' but not '/x'.
		const piOnly = runExtract(env, "--source", "pi", "--cwd", "/x");
		assert.equal(piOnly.length, 1);
		const missed = runExtract(env, "--source", "pi", "--cwd", "definitely-not-here");
		assert.equal(missed.length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractor skips thinking, tool results, and assistant turns by default", async () => {
	const { dir, env } = await makeFixture();
	try {
		const records = runExtract(env, "--source", "pi");
		assert.equal(records.length, 1, "only the user turn survives");

		const withAssistant = runExtract(env, "--source", "pi", "--roles", "user,assistant");
		assert.equal(withAssistant.length, 2);
		assert.equal(withAssistant.find((r) => r.role === "assistant")?.text, "understood");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractor honors --since, --limit, and --list-sources", async () => {
	const { dir, env } = await makeFixture();
	try {
		const recent = runExtract(env, "--source", "pi,claude", "--since", "2026-08-02");
		assert.deepEqual(
			recent.map((r) => r.source),
			["claude"],
		);

		// The cap is per source, newest first: one message per source survives.
		const limited = runExtract(env, "--source", "all", "--roles", "user", "--limit", "1");
		assert.equal(limited.length, 4);
		assert.deepEqual([...new Set(limited.map((r) => r.source))].sort(), ["claude", "codex", "cursor", "pi"]);

		const listing = execFileSync("python3", [EXTRACT, "--list-sources"], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		assert.match(listing, /pi: 1 file/);
		assert.match(listing, /claude: 1 file\(s\)/, "subagent files excluded from the default listing count");
		assert.match(listing, /cursor: 1 file/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("extractor tolerates malformed lines and missing directories", async () => {
	const dir = await mkdtemp(join(tmpdir(), "personalize-test-"));
	try {
		await writeFile(join(dir, "bad.jsonl"), '{"type":"message", broken\n{"type":"session","id":"s"}\n');
		const records = runExtract({ PERSONALIZE_PI_HOME: dir }, "--source", "pi");
		assert.deepEqual(records, []);

		const empty = runExtract(
			{ PERSONALIZE_PI_HOME: join(dir, "nope"), PERSONALIZE_CURSOR_HOME: join(dir, "nope") },
			"--source",
			"pi,cursor",
		);
		assert.deepEqual(empty, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
