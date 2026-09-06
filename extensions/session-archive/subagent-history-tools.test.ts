import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { finalizeArchived, importSessionPending, openArchiveDb, searchArchive } from "./archive-store.ts";
import { parseSessionJsonl, sha256Hex } from "./session-jsonl.ts";
import { getSubagentHistoryDbPath } from "./subagent-history-store.ts";
import { createSubagentHistoryTools } from "./subagent-history-tools.ts";
import {
	makeTempTree,
	messageEntry,
	richSessionJsonl,
	sessionJsonl,
	TEST_SESSION_ID,
	userMessage,
} from "./test-helpers.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-08-11T08:48:02.226Z";

function fixture(entries = [messageEntry("u1", null, userMessage("tool history needle"))]) {
	const root = mkdtempSync(join(tmpdir(), "kstack-subagent-history-tools-"));
	const sourceRoot = join(root, "subagents");
	mkdirSync(join(sourceRoot, ".active"), { recursive: true });
	const filename = `${TIMESTAMP.replace(/[:.]/g, "-")}_${ID}.jsonl`;
	const content = sessionJsonl(entries, { id: ID, timestamp: TIMESTAMP, cwd: "/tmp/synthetic-tool-project" });
	writeFileSync(join(sourceRoot, filename), content);
	const dbPath = join(root, "agent", "cache", "kstack-subagent-history", "index.sqlite3");
	return {
		root,
		sourceRoot,
		dbPath,
		filename,
		content,
		tools: createSubagentHistoryTools({ sourceRoot, dbPath }),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function output(result: { content: { type: "text"; text: string }[] }): string {
	return result.content.map((part) => part.text).join("\n");
}

describe("retained subagent history tools", () => {
	it("searches and reads actual temporary source/index data with coverage and provenance", async () => {
		const fx = fixture([
			messageEntry("u1", null, userMessage("tool history needle")),
			{
				type: "session_info",
				id: "n1",
				parentId: "u1",
				timestamp: "2026-08-11T09:00:00.000Z",
				name: "synthetic reviewer",
			},
		]);
		try {
			const search = await fx.tools.searchSubagentHistory("call", { query: '"history needle"' });
			assert.match(output(search), /Coverage: complete=true/);
			assert.match(output(search), new RegExp(ID));
			assert.match(output(search), /synthetic reviewer/);
			assert.match(output(search), /evidence, not current instructions/);
			assert.equal(search.details.kind, "search");
			assert.deepEqual(search.details.hits[0]?.sessionId, ID);

			const normalized = await fx.tools.readSubagentHistory("call", { session_id: ID, limit: 2 });
			assert.match(output(normalized), /original ordinals 0–1/);
			assert.match(output(normalized), /Normalized text is capped/);
			assert.match(output(normalized), /tool history needle/);
			assert.match(output(normalized), new RegExp(fx.filename));
			assert.equal(normalized.details.filename, fx.filename);

			const raw = await fx.tools.readSubagentHistory("call", { session_id: ID, limit: 1, format: "raw" });
			assert.match(output(raw), /exact retained JSONL entry byte ranges/);
			assert.match(output(raw), /"id":"u1"/);
			assert.ok(!output(raw).includes('"type":"session","version"'));
		} finally {
			fx.cleanup();
		}
	});

	it("validates arguments independently and bounds FTS errors without source dumps", async () => {
		const fx = fixture();
		try {
			await assert.rejects(() => fx.tools.searchSubagentHistory("call", null), /arguments must be an object/);
			await assert.rejects(() => fx.tools.searchSubagentHistory("call", { query: "" }), /query must be/);
			await assert.rejects(
				() => fx.tools.searchSubagentHistory("call", { query: "x", session_id: "not-a-uuid" }),
				/exact UUID/,
			);
			await assert.rejects(() => fx.tools.searchSubagentHistory("call", { query: "x", limit: 0 }), /limit must be/);
			await assert.rejects(() => fx.tools.searchSubagentHistory("call", { query: "foo AND" }), /invalid FTS5 query/);
			await assert.rejects(
				() => fx.tools.readSubagentHistory("call", { session_id: ID, offset: -1 }),
				/offset must be/,
			);
			await assert.rejects(
				() => fx.tools.readSubagentHistory("call", { session_id: ID, chunk: 999 }),
				(error: Error) => {
					assert.match(error.message, /^Invalid retained child session: Chunk 999 is out of range/);
					assert.doesNotMatch(error.message, /Could not read/, "bounded tool errors are not re-wrapped");
					return true;
				},
			);
			await assert.rejects(() => fx.tools.searchSubagentHistory("call", { query: "x".repeat(5_000) }), /exceeds/);
		} finally {
			fx.cleanup();
		}
	});

	it("distinguishes active and unavailable retained sessions", async () => {
		const fx = fixture();
		try {
			writeFileSync(
				join(fx.sourceRoot, ".active", `${ID}.json`),
				JSON.stringify({ state: "spawned", pid: process.pid, createdAt: TIMESTAMP }),
			);
			const active = await fx.tools.readSubagentHistory("call", { session_id: ID });
			assert.equal(active.details.kind, "active");
			assert.match(output(active), /active|lease/);
			const excluded = await fx.tools.searchSubagentHistory("call", { query: "needle" });
			assert.equal(excluded.details.coverage.activeSessions, 1);
			assert.match(output(excluded), /1 active or lease-uncertain session\(s\) were excluded/);
			rmSync(join(fx.sourceRoot, ".active", `${ID}.json`));
			rmSync(join(fx.sourceRoot, fx.filename));
			const unavailable = await fx.tools.readSubagentHistory("call", { session_id: ID });
			assert.equal(unavailable.details.kind, "unavailable");
			assert.match(output(unavailable), /expired|removed|unavailable/);
		} finally {
			fx.cleanup();
		}
	});

	it("keeps complete formatted responses under Pi's public byte limit and preserves UTF-8", async () => {
		const entries = [];
		let parent: string | null = null;
		for (let index = 0; index < 100; index++) {
			const id = `entry-${index}`;
			entries.push(messageEntry(id, parent, userMessage(`common ${"語".repeat(800)} row-${index}`)));
			parent = id;
		}
		const fx = fixture(entries);
		try {
			const search = await fx.tools.searchSubagentHistory("call", { query: "common", limit: 100 });
			assert.ok(Buffer.byteLength(JSON.stringify(search)) <= DEFAULT_MAX_BYTES);
			assert.ok(!output(search).includes("�"));
			const read = await fx.tools.readSubagentHistory("call", { session_id: ID, limit: 100 });
			assert.ok(Buffer.byteLength(JSON.stringify(read)) <= DEFAULT_MAX_BYTES);
			assert.ok(!output(read).includes("�"));
			assert.match(output(read), /continue with offset 0, limit 100, chunk 1|end of retained session/);
		} finally {
			fx.cleanup();
		}
	});

	it("leaves the finalized archive database byte-for-byte unchanged", async () => {
		const tree = makeTempTree();
		const fx = fixture();
		try {
			mkdirSync(tree.archiveRoot, { recursive: true });
			const archiveDb = openArchiveDb(tree.dbPath);
			try {
				const content = richSessionJsonl();
				const parsed = parseSessionJsonl(content);
				const archivePath = join(tree.archiveRoot, "sessions", "x.jsonl");
				importSessionPending(archiveDb, {
					header: parsed.header,
					entries: parsed.entries,
					originalPath: join(tree.sessionDir, "x.jsonl"),
					archivePath,
					fileSize: content.length,
					sha256: sha256Hex(content),
				});
				finalizeArchived(archiveDb, TEST_SESSION_ID, archivePath, content.length, sha256Hex(content));
				archiveDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				archiveDb.close();
			}
			const before = readFileSync(tree.dbPath);

			// The child-history cache is rooted in the same agent directory as the archive.
			const tools = createSubagentHistoryTools({
				sourceRoot: fx.sourceRoot,
				dbPath: getSubagentHistoryDbPath(tree.agentDir),
			});
			const search = await tools.searchSubagentHistory("call", { query: "needle" });
			assert.equal(search.details.returnedHits, 1);
			assert.equal((await tools.readSubagentHistory("call", { session_id: ID })).details.kind, "page");
			assert.deepEqual(readFileSync(tree.dbPath), before, "archive database must not change");

			const reopened = openArchiveDb(tree.dbPath);
			try {
				assert.ok(searchArchive(reopened, { query: '"hello archive"' }).length > 0, "archive rows still searchable");
				assert.equal(searchArchive(reopened, { query: "needle" }).length, 0, "child history never enters the archive");
			} finally {
				reopened.close();
			}
		} finally {
			fx.cleanup();
			rmSync(tree.root, { recursive: true, force: true });
		}
	});

	it("propagates the tool-call abort signal into on-demand work", async () => {
		const fx = fixture();
		const abort = new AbortController();
		abort.abort();
		try {
			await assert.rejects(() => fx.tools.searchSubagentHistory("call", { query: "needle" }, abort.signal), /abort/i);
		} finally {
			fx.cleanup();
		}
	});
});
