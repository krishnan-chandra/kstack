import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
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
	preflightHandoffHistory,
	readHandoffHistory,
	searchHandoffHistory,
} from "./history-reader.ts";

const roots: string[] = [];
afterEach(() => {
	clearHandoffParseCache();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
	content = sessionJsonl([
		messageEntry("u1", null, userMessage("initial architecture discussion")),
		messageEntry("a1", "u1", assistantMessage("decided to use a reference-only handoff")),
		messageEntry("u2", "a1", userMessage("resume by implementing the history reader")),
	]),
) {
	const tree = makeTempTree();
	roots.push(tree.root);
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

function caseSearchFixture() {
	return fixture(
		sessionJsonl([
			messageEntry("u1", null, userMessage("SQLite records HEAD and API with a Mixed Case Phrase.")),
			messageEntry("a1", "u1", assistantMessage("Unicode marker: Überprüfung.")),
			messageEntry("u2", "a1", userMessage("Later SQLite and API result keeps OriginalCase.")),
			messageEntry("a2", "u2", assistantMessage("API-only tail marker.")),
		]),
	);
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
			{
				type: "custom_message",
				customType: "handoff",
				content: "visible",
				details: {
					version: 1,
					sessionFile: source.sessionFile,
					sessionId: source.sessionId,
					cwd: source.cwd,
				},
			},
		]);
		assert.deepEqual(found, source);
	});

	it("constructs HandoffSource without copying extra details fields", () => {
		const found = findHandoffSource([
			{
				type: "custom_message",
				customType: "handoff",
				details: {
					version: 1,
					sessionFile: "/sessions/latest.jsonl",
					sessionId: TEST_SESSION_ID,
					cwd: "/project",
					extra: "drop-me",
				},
			},
		]);
		assert.deepEqual(found, {
			version: 1,
			sessionFile: "/sessions/latest.jsonl",
			sessionId: TEST_SESSION_ID,
			cwd: "/project",
		});
		assert.equal(found && "extra" in found, false);
	});

	it("ignores malformed details and falls back to legacy content", () => {
		const found = findHandoffSource([
			{
				type: "custom_message",
				customType: "handoff",
				content: `Previous session: /sessions/old.jsonl\nSession ID: ${TEST_SESSION_ID}  CWD: /project`,
				details: { version: 2, sessionFile: "/sessions/wrong.jsonl" },
			},
		]);
		assert.equal(found?.sessionFile, "/sessions/old.jsonl");
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

describe("preflightHandoffHistory", () => {
	it("accepts a readable session under Pi's active-session root", () => {
		const { source, env } = fixture();
		assert.deepEqual(preflightHandoffHistory(source, env), { kind: "ready" });
	});

	it("rereads current bytes when cached file metadata is unchanged", () => {
		const { content, source, env } = fixture();
		const cachedStat = statSync(source.sessionFile);
		const fsImpl: HandoffHistoryFs = {
			statSync: () => cachedStat,
			readFileSync,
		};
		readHandoffHistory(source, {}, env, fsImpl);
		const replacement = content.replace(TEST_SESSION_ID, "11111111-2222-3333-4444-555555555555");
		assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(content));
		writeFileSync(source.sessionFile, replacement);

		const result = preflightHandoffHistory(source, env, fsImpl);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") assert.match(result.reason, /session ID mismatch/i);
	});

	it("rejects a valid custom session outside Pi's active-session root", () => {
		const { tree, source, env } = fixture();
		const customFile = join(tree.root, "custom.jsonl");
		writeFileSync(customFile, sessionJsonl([], { id: source.sessionId }));

		const result = preflightHandoffHistory({ ...source, sessionFile: customFile }, env);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") assert.match(result.reason, /outside Pi's active session directory/i);
	});

	it("rejects symlinks and directories", () => {
		const { tree, source, env } = fixture();
		const symlink = join(tree.sessionDir, "linked.jsonl");
		const directory = join(tree.sessionDir, "directory.jsonl");
		symlinkSync(source.sessionFile, symlink);
		mkdirSync(directory);

		for (const sessionFile of [symlink, directory]) {
			const result = preflightHandoffHistory({ ...source, sessionFile }, env);
			assert.equal(result.kind, "rejected");
			if (result.kind === "rejected") assert.match(result.reason, /regular non-symlink file/i);
		}
	});

	it("rejects a missing active source even when the exact session is archived", () => {
		const { tree, content, source, env } = fixture();
		archiveAndRemoveActive(tree, content, source);

		const result = preflightHandoffHistory(source, env);

		assert.deepEqual(result, {
			kind: "rejected",
			reason: "The source session no longer exists at its recorded active path.",
		});
	});

	it("rejects malformed JSONL and a mismatched header id", () => {
		for (const content of ["not-json\n", sessionJsonl([], { id: "11111111-2222-3333-4444-555555555555" })]) {
			const { source, env } = fixture();
			writeFileSync(source.sessionFile, content);

			const result = preflightHandoffHistory(source, env);

			assert.equal(result.kind, "rejected");
			if (result.kind === "rejected") assert.match(result.reason, /valid JSON|session ID mismatch/i);
			clearHandoffParseCache();
		}
	});

	it("rejects an oversized active source before reading it", () => {
		const { source, env } = fixture();
		truncateSync(source.sessionFile, 64 * 1024 * 1024 + 1);

		const result = preflightHandoffHistory(source, env);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") assert.match(result.reason, /active-reader limit/i);
	});

	it("bounds rejection reasons", () => {
		const { source, env } = fixture();
		const result = preflightHandoffHistory({ ...source, sessionId: "x".repeat(10_000) }, env);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") {
			assert.ok(Buffer.byteLength(result.reason) <= 1024);
			assert.ok(result.reason.endsWith("..."));
		}
	});
});

describe("readHandoffHistory", () => {
	it("reuses a parsed session while the file identity is unchanged", () => {
		const { source, env } = fixture();
		let reads = 0;
		const fsImpl: HandoffHistoryFs = {
			statSync,
			readFileSync: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ((
				...args: Parameters<typeof readFileSync>
			) => {
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
	it("matches technical identifiers and a quoted phrase regardless of query case before and after archival", () => {
		const { tree, content, source, env } = caseSearchFixture();
		const queries = [
			"SQLITE",
			"sqlite",
			"SqLiTe",
			"HEAD",
			"head",
			"HeAd",
			"API",
			"api",
			"aPi",
			'"MIXED CASE PHRASE"',
			'"mixed case phrase"',
			'"MiXeD CaSe PhRaSe"',
		];
		for (const query of queries) {
			assert.match(searchHandoffHistory(source, { query }, env), /Matches in active previous session/);
		}

		archiveAndRemoveActive(tree, content, source);
		for (const query of queries) {
			assert.match(searchHandoffHistory(source, { query }, env), /Matches in archived previous session/);
		}
	});

	it("matches non-ASCII upper and lower case without changing result text", () => {
		const { source, env } = caseSearchFixture();

		for (const query of ["ÜBERPRÜFUNG", "überprüfung"]) {
			const output = searchHandoffHistory(source, { query }, env);
			assert.match(output, /Unicode marker: Überprüfung\./);
		}
	});

	it("preserves AND, no-match, role, and tail-limit behavior", () => {
		const { source, env } = caseSearchFixture();

		const latestUserMatch = searchHandoffHistory(source, { query: "SQLITE api", role: "user", limit: 1 }, env);
		assert.match(latestUserMatch, /Later SQLite and API result keeps OriginalCase\./);
		assert.doesNotMatch(latestUserMatch, /Mixed Case Phrase/);

		const assistantMatch = searchHandoffHistory(source, { query: "api", role: "assistant" }, env);
		assert.match(assistantMatch, /API-only tail marker\./);
		assert.doesNotMatch(assistantMatch, /OriginalCase/);

		assert.match(
			searchHandoffHistory(source, { query: "sqlite absent" }, env),
			/No matches in active previous session/,
		);
	});

	it("searches only normalized text in the active previous session", () => {
		const { source, env } = fixture();
		const output = searchHandoffHistory(source, { query: "reference handoff" }, env);
		assert.ok(output.includes("reference-only handoff"));
		assert.ok(!output.includes("initial architecture discussion"));
	});

	it("falls back to scoped archive search", () => {
		const { tree, content, source, env } = fixture();
		archiveAndRemoveActive(tree, content, source);
		const output = searchHandoffHistory(source, { query: '"history reader"' }, env);
		assert.ok(output.includes("archived previous session"));
		assert.ok(output.includes("history reader"));
	});

	it("rejects empty queries and empty quoted phrases", () => {
		const { source, env } = fixture();
		assert.throws(() => searchHandoffHistory(source, { query: "  " }, env), /must not be empty/);
		assert.throws(() => searchHandoffHistory(source, { query: '""' }, env), /at least one word or quoted phrase/);
	});
});
