import assert from "node:assert/strict";
import { appendFileSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { finalizeArchived, importSessionPending, openArchiveDb } from "../session-archive/archive-store.ts";
import { parseSessionJsonl, sha256Hex } from "../session-archive/session-jsonl.ts";
import {
	assistantMessage,
	makeTempTree,
	messageEntry,
	sessionJsonl,
	TEST_SESSION_ID,
	userMessage,
} from "../session-archive/test-helpers.ts";
import {
	clearHandoffParseCache,
	findHandoffSource,
	type HandoffHistoryFs,
	type HandoffSource,
	readHandoffHistory,
	searchHandoffHistory,
} from "./history-reader.ts";

const roots: string[] = [];
afterEach(() => {
	clearHandoffParseCache();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const tree = makeTempTree();
	roots.push(tree.root);
	const content = sessionJsonl([
		messageEntry("u1", null, userMessage("initial architecture discussion")),
		messageEntry("a1", "u1", assistantMessage("decided to use a reference-only handoff")),
		messageEntry("u2", "a1", userMessage("resume by implementing the history reader")),
	]);
	const sessionFile = tree.writeSession(TEST_SESSION_ID, content);
	const source: HandoffSource = {
		version: 1,
		sessionFile,
		sessionId: TEST_SESSION_ID,
		cwd: "/Users/test/Code/project",
	};
	const env = { ...process.env, PI_CODING_AGENT_DIR: tree.agentDir };
	return { tree, content, source, env };
}

function archiveAndRemoveActive(tree: ReturnType<typeof makeTempTree>, content: string, source: HandoffSource): void {
	const parsed = parseSessionJsonl(content);
	const archivePath = join(tree.archiveRoot, "sessions", "archived.jsonl");
	const hash = sha256Hex(content);
	const size = Buffer.byteLength(content);
	const db = openArchiveDb(tree.dbPath);
	try {
		importSessionPending(db, {
			header: parsed.header,
			entries: parsed.entries,
			originalPath: source.sessionFile,
			archivePath,
			fileSize: size,
			sha256: hash,
		});
		finalizeArchived(db, source.sessionId, archivePath, size, hash);
	} finally {
		db.close();
	}
	unlinkSync(source.sessionFile);
}

describe("findHandoffSource", () => {
	it("prefers structured details from the latest handoff entry", () => {
		const source: HandoffSource = {
			version: 1,
			sessionFile: "/sessions/latest.jsonl",
			sessionId: TEST_SESSION_ID,
			cwd: "/project",
		};
		const found = findHandoffSource([
			{ type: "custom_message", customType: "handoff", content: "old" },
			{ type: "custom_message", customType: "handoff", content: "visible", details: source },
		]);
		assert.deepEqual(found, source);
	});

	it("parses legacy visible references without accepting ephemeral ones", () => {
		const found = findHandoffSource([
			{
				type: "custom_message",
				customType: "handoff",
				content: `Previous session: /sessions/old.jsonl\nSession ID: ${TEST_SESSION_ID}  CWD: /project`,
			},
		]);
		assert.equal(found?.sessionFile, "/sessions/old.jsonl");
		assert.equal(
			findHandoffSource([
				{
					type: "custom_message",
					customType: "handoff",
					content: `Previous session: (ephemeral — no file)\nSession ID: ${TEST_SESSION_ID}  CWD: /project`,
				},
			]),
			undefined,
		);
	});
});

describe("readHandoffHistory", () => {
	it("reuses a parsed session while the file identity is unchanged", () => {
		const { source, env } = fixture();
		let reads = 0;
		const fsImpl: HandoffHistoryFs = {
			statSync,
			readFileSync: ((...args: Parameters<typeof readFileSync>) => {
				reads++;
				return readFileSync(...args);
			}) as typeof readFileSync,
		};

		readHandoffHistory(source, {}, env, fsImpl);
		readHandoffHistory(source, {}, env, fsImpl);

		assert.equal(reads, 1);
	});

	it("invalidates the cache when the active session grows", () => {
		const { source, env } = fixture();
		readHandoffHistory(source, {}, env);
		appendFileSync(
			source.sessionFile,
			`${JSON.stringify(messageEntry("u3", "u2", userMessage("appended cache entry")))}\n`,
		);

		const output = readHandoffHistory(source, {}, env);

		assert.ok(output.includes("entries 1–4 of 4"));
		assert.ok(output.includes("appended cache entry"));
	});

	it("does not serve cached content after the file is replaced with another session id", () => {
		const { source, env } = fixture();
		readHandoffHistory(source, {}, env);
		const replacement = `${source.sessionFile}.replacement`;
		writeFileSync(replacement, sessionJsonl([], { id: "11111111-2222-3333-4444-555555555555" }));
		renameSync(replacement, source.sessionFile);

		assert.throws(() => readHandoffHistory(source, {}, env), /session ID mismatch/i);
	});

	it("reads normalized recent entries by default and omits thinking/tool arguments", () => {
		const { source, env } = fixture();
		const output = readHandoffHistory(source, { limit: 2 }, env);
		assert.ok(output.includes("source: active"));
		assert.ok(output.includes("entries 2–3 of 3"));
		assert.ok(output.includes("reference-only handoff"));
		assert.ok(output.includes("history reader"));
		assert.ok(!output.includes("secret chain of thought"));
		assert.ok(!output.includes('"command":"ls"'));
	});

	it("defaults to the latest 20 entries", () => {
		const { source, env } = fixture();
		const entries = Array.from({ length: 25 }, (_, index) =>
			messageEntry(`u${index}`, index === 0 ? null : `u${index - 1}`, userMessage(`entry-${index + 1}`)),
		);
		writeFileSync(source.sessionFile, sessionJsonl(entries));

		const output = readHandoffHistory(source, {}, env);

		assert.ok(output.includes("entries 6–25 of 25"));
		assert.ok(!output.includes("entry-5\n"));
		assert.ok(output.includes("entry-6"));
	});

	it("supports paging from the start", () => {
		const { source, env } = fixture();
		const output = readHandoffHistory(source, { from: "start", limit: 1 }, env);
		assert.ok(output.includes("entries 1–1 of 3"));
		assert.ok(output.includes("initial architecture discussion"));
		assert.ok(output.includes("continue with offset 1"));
	});

	it("falls back to the finalized read-only archive by exact session id", () => {
		const { tree, content, source, env } = fixture();
		archiveAndRemoveActive(tree, content, source);

		const output = readHandoffHistory(source, { limit: 1 }, env);
		assert.ok(output.includes("source: archived"));
		assert.ok(output.includes("history reader"));
	});

	it("rejects a source whose file header does not match the referenced session id", () => {
		const { source, env } = fixture();
		writeFileSync(source.sessionFile, sessionJsonl([], { id: "11111111-2222-3333-4444-555555555555" }));
		assert.throws(() => readHandoffHistory(source, {}, env), /session ID mismatch/i);
	});

	it("rejects an existing source outside Pi's active session directory", () => {
		const { tree, source, env } = fixture();
		const outside = join(tree.root, "outside.jsonl");
		writeFileSync(outside, sessionJsonl([]));
		assert.throws(
			() => readHandoffHistory({ ...source, sessionFile: outside }, {}, env),
			/outside Pi's active session directory/,
		);
	});
});

describe("searchHandoffHistory", () => {
	it("searches only normalized text in the active previous session", () => {
		const { source, env } = fixture();
		const output = searchHandoffHistory(source, { query: "reference handoff" }, env);
		assert.ok(output.includes("reference-only handoff"));
		assert.ok(!output.includes("initial architecture discussion"));
	});

	it("reports archived match offsets that can be passed to the history reader", () => {
		const { tree, content, source, env } = fixture();
		archiveAndRemoveActive(tree, content, source);

		const searchOutput = searchHandoffHistory(source, { query: '"history reader"' }, env);
		assert.ok(searchOutput.includes("archived previous session"));
		assert.match(searchOutput, /^#2 \[user\]/m);

		const readOutput = readHandoffHistory(source, { offset: 2, limit: 1, from: "start" }, env);
		assert.ok(readOutput.includes("history reader"));
	});

	it("rejects an empty query", () => {
		const { source, env } = fixture();
		assert.throws(() => searchHandoffHistory(source, { query: "  " }, env), /must not be empty/);
	});
});
