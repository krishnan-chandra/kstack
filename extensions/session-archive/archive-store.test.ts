import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
	ArchiveStoreError,
	countEntries,
	finalizeArchived,
	FtsQueryError,
	getArchiveStats,
	getSessionRow,
	importSessionPending,
	listSessionRows,
	markError,
	openArchiveDb,
	openArchiveDbReadOnly,
	readEntries,
	searchArchive,
	type PendingImport,
} from "./archive-store.ts";
import { parseSessionJsonl, sha256Hex } from "./session-jsonl.ts";
import { makeTempTree, richSessionJsonl, sessionJsonl, messageEntry, userMessage, TEST_SESSION_ID } from "./test-helpers.ts";

function importFromContent(content: string, overrides: Partial<PendingImport> = {}): PendingImport {
	const parsed = parseSessionJsonl(content);
	return {
		header: parsed.header,
		entries: parsed.entries,
		originalPath: "/active/sessions/session.jsonl",
		archivePath: "/archive/sessions/2026/08/x/session.jsonl",
		fileSize: content.length,
		sha256: sha256Hex(content),
		...overrides,
	};
}

function archiveContent(db: DatabaseSync, content: string, overrides: Partial<PendingImport> = {}): PendingImport {
	const input = importFromContent(content, overrides);
	importSessionPending(db, input);
	finalizeArchived(db, input.header.id, input.archivePath, input.fileSize, input.sha256);
	return input;
}

describe("archive-store", () => {
	it("initializes an empty database and reopens it", () => {
		const tree = makeTempTree();
		const db = openArchiveDb(tree.dbPath);
		const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
		assert.equal(version.user_version, 1);
		db.exec("PRAGMA foreign_keys=ON");
		assert.ok(existsSync(tree.dbPath));
		db.close();
		// Second open: schema already present, no error.
		const again = openArchiveDb(tree.dbPath);
		try {
			const sessionColumns = again.prepare("PRAGMA table_info(archive_sessions)").all() as unknown as { name: string }[];
			const entryColumns = again.prepare("PRAGMA table_info(archive_entries)").all() as unknown as { name: string }[];
			assert.ok(!sessionColumns.some((column) => column.name === "header_raw_json"));
			assert.ok(!entryColumns.some((column) => column.name === "raw_json"));
			assert.ok(entryColumns.some((column) => column.name === "raw_offset"));
			assert.ok(entryColumns.some((column) => column.name === "raw_length"));
		} finally {
			again.close();
		}
	});

	it("rejects unsupported schema versions", () => {
		const tree = makeTempTree();
		const db = openArchiveDb(tree.dbPath);
		db.exec("PRAGMA user_version=2");
		db.close();
		assert.throws(() => openArchiveDb(tree.dbPath), /unsupported archive schema version 2/);
	});

	it("opens existing archives read-only without creating or mutating them", () => {
		const tree = makeTempTree();
		assert.throws(() => openArchiveDbReadOnly(tree.dbPath));
		assert.ok(!existsSync(tree.dbPath));

		const writable = openArchiveDb(tree.dbPath);
		writable.close();
		const readOnly = openArchiveDbReadOnly(tree.dbPath);
		try {
			assert.equal((readOnly.prepare("PRAGMA query_only").get() as { query_only: number }).query_only, 1);
			assert.throws(() => readOnly.exec("DELETE FROM archive_sessions"), /read.?only/i);
		} finally {
			readOnly.close();
		}
	});

	it("creates the database file owner-only where POSIX modes exist", () => {
		if (process.platform === "win32") return;
		const tree = makeTempTree();
		const db = openArchiveDb(tree.dbPath);
		db.close();
		assert.equal(statSync(tree.dbPath).mode & 0o777, 0o600);
	});

	it("imports a session as pending with all entries and FTS text", () => {
		const db = openArchiveDb(":memory:");
		try {
			const content = richSessionJsonl();
			assert.equal(importSessionPending(db, importFromContent(content)), "imported");
			const row = getSessionRow(db, TEST_SESSION_ID);
			assert.equal(row?.state, "pending");
			assert.equal(row?.entry_count, 12);
			assert.equal(row?.name, "archive test session");
			assert.equal(row?.archive_path, "/archive/sessions/2026/08/x/session.jsonl");
			assert.equal(countEntries(db, TEST_SESSION_ID), 12);

			assert.equal(searchArchive(db, { query: "archiving" }).length, 0);
			finalizeArchived(db, TEST_SESSION_ID, "/archive/sessions/2026/08/x/session.jsonl", content.length, sha256Hex(content));
			const hits = searchArchive(db, { query: "archiving" });
			assert.ok(hits.some((h) => h.entry_id === "a1"));
			assert.ok(hits.some((h) => h.snippet.includes("[")));
		} finally {
			db.close();
		}
	});

	it("preserves an explicit session-name clear instead of resurrecting an older name", () => {
		const db = openArchiveDb(":memory:");
		try {
			const content = sessionJsonl([
				{ type: "session_info", id: "n1", parentId: null, timestamp: "2026-08-11T08:49:00.000Z", name: "old name" },
				{ type: "session_info", id: "n2", parentId: "n1", timestamp: "2026-08-11T08:50:00.000Z" },
			]);
			importSessionPending(db, importFromContent(content));
			assert.equal(getSessionRow(db, TEST_SESSION_ID)?.name, null);
		} finally {
			db.close();
		}
	});

	it("search hits user, assistant, tool-result, bash, compaction, branch-summary, and custom-message text", () => {
		const db = openArchiveDb(":memory:");
		try {
			archiveContent(db, richSessionJsonl());
			const kinds: [string, string][] = [
				["hello archive world", "u1"],
				["archiving works", "a1"],
				["42 files listed", "t1"],
				["archive-marker", "b1"],
				["discussed archiving", "c1"],
				["alternate archive layout", "s1"],
				["injected archive context", "x1"],
			];
			for (const [term, entryId] of kinds) {
				const hits = searchArchive(db, { query: `"${term}"` });
				assert.ok(
					hits.some((h) => h.entry_id === entryId),
					`expected hit for ${entryId} on query ${term}`,
				);
			}
			// base64 image data is not indexed
			assert.equal(searchArchive(db, { query: "aGVsbG8" }).length, 0);
		} finally {
			db.close();
		}
	});

	it("filters search by cwd, role, and session id", () => {
		const db = openArchiveDb(":memory:");
		try {
			archiveContent(db, richSessionJsonl());
			assert.ok(searchArchive(db, { query: "archive", cwd: "/Users/test/Code/project" }).length > 0);
			assert.equal(searchArchive(db, { query: "archive", cwd: "/elsewhere" }).length, 0);
			assert.ok(searchArchive(db, { query: "archive", role: "assistant" }).every((h) => h.role === "assistant"));
			assert.ok(searchArchive(db, { query: "archive", sessionId: TEST_SESSION_ID }).length > 0);
			assert.equal(searchArchive(db, { query: "archive", sessionId: "nope" }).length, 0);
		} finally {
			db.close();
		}
	});

	it("bounds search limits", () => {
		const db = openArchiveDb(":memory:");
		try {
			archiveContent(db, richSessionJsonl());
			assert.ok(searchArchive(db, { query: "archive", limit: 2 }).length <= 2);
			assert.ok(searchArchive(db, { query: "archive", limit: 99999 }).length <= 100);
			assert.ok(searchArchive(db, { query: "archive", limit: 1.5 }).length <= 1);
		} finally {
			db.close();
		}
	});

	it("turns malformed FTS syntax into an actionable error", () => {
		const db = openArchiveDb(":memory:");
		try {
			archiveContent(db, richSessionJsonl());
			assert.throws(() => searchArchive(db, { query: "foo AND" }), FtsQueryError);
			assert.throws(() => searchArchive(db, { query: '"unclosed' }), FtsQueryError);
		} finally {
			db.close();
		}
	});

	it("does not mislabel operational SQLite failures as FTS query errors", () => {
		const db = openArchiveDb(":memory:");
		try {
			db.exec("DROP TABLE archive_entries_fts");
			assert.throws(
				() => searchArchive(db, { query: "valid" }),
				(error: unknown) => error instanceof Error && !(error instanceof FtsQueryError) && /no such table/.test(error.message),
			);
		} finally {
			db.close();
		}
	});

	it("is idempotent: re-importing replaces rather than duplicates", () => {
		const db = openArchiveDb(":memory:");
		try {
			const content = richSessionJsonl();
			importSessionPending(db, importFromContent(content));
			importSessionPending(db, importFromContent(content));
			assert.equal(countEntries(db, TEST_SESSION_ID), 12);
			assert.equal(getArchiveStats(db).sessionsPending, 1);
		} finally {
			db.close();
		}
	});

	it("finalizes pending sessions and refuses to re-import different bytes over archived ones", () => {
		const db = openArchiveDb(":memory:");
		try {
			const content = richSessionJsonl();
			importSessionPending(db, importFromContent(content));
			const sha = sha256Hex(content);
			const archivePath = "/archive/sessions/2026/08/x/session.jsonl";
			assert.equal(finalizeArchived(db, TEST_SESSION_ID, archivePath, content.length, sha), "finalized");
			assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "archived");
			// Idempotent re-finalize
			assert.equal(finalizeArchived(db, TEST_SESSION_ID, archivePath, content.length, sha), "already-archived");
			// Re-import with same bytes is a no-op
			assert.equal(importSessionPending(db, importFromContent(content)), "already-archived");
			// Same id, different bytes: hard error
			const other = richSessionJsonl({ id: TEST_SESSION_ID }) + "";
			const tampered = other.replace("hello archive world", "tampered content here");
			assert.throws(
				() => importSessionPending(db, importFromContent(tampered)),
				ArchiveStoreError,
			);
		} finally {
			db.close();
		}
	});

	it("does not let a conflicting pending import or finalizer mix file and entry identities", () => {
		const db = openArchiveDb(":memory:");
		try {
			const contentA = richSessionJsonl();
			const contentB = contentA.replace("hello archive world", "different pending bytes");
			const pendingA = importFromContent(contentA);
			importSessionPending(db, pendingA);
			assert.throws(
				() => importSessionPending(db, importFromContent(contentB)),
				/different pending archive operation/,
			);
			assert.throws(
				() => finalizeArchived(db, TEST_SESSION_ID, pendingA.archivePath, contentB.length, sha256Hex(contentB)),
				/no longer matches/,
			);
			assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "pending");
			assert.equal(readEntries(db, TEST_SESSION_ID, 0, 2)[1].entry_id, "u1");
			assert.equal(
				finalizeArchived(db, TEST_SESSION_ID, pendingA.archivePath, contentA.length, sha256Hex(contentA)),
				"finalized",
			);
		} finally {
			db.close();
		}
	});

	it("finalize requires a known session", () => {
		const db = openArchiveDb(":memory:");
		try {
			assert.throws(() => finalizeArchived(db, "nope", "/x", 1, "sha"), ArchiveStoreError);
		} finally {
			db.close();
		}
	});

	it("rolls back failed imports without partial rows", () => {
		const db = openArchiveDb(":memory:");
		try {
			// An import whose entries violate a constraint mid-transaction must
			// leave neither the session row nor any entries behind.
			const parsed = parseSessionJsonl(richSessionJsonl());
			const broken = {
				...importFromContent(richSessionJsonl()),
				entries: parsed.entries.map((e, i) =>
					i === 5 ? { ...e, entryId: parsed.entries[0].entryId } : e,
				),
			};
			assert.throws(() => importSessionPending(db, broken));
			assert.equal(getSessionRow(db, TEST_SESSION_ID), undefined);
			assert.equal(countEntries(db, TEST_SESSION_ID), 0);
		} finally {
			db.close();
		}
	});

	it("reads entries back with paging, parent ids, and source byte references", () => {
		const db = openArchiveDb(":memory:");
		try {
			const content = richSessionJsonl();
			importSessionPending(db, importFromContent(content));
			const page1 = readEntries(db, TEST_SESSION_ID, 0, 5);
			assert.equal(page1.length, 5);
			assert.equal(page1[0].entry_id, "m0");
			assert.equal(page1[1].parent_id, "m0");
			const page2 = readEntries(db, TEST_SESSION_ID, 5, 50);
			assert.equal(page2.length, 7);
			assert.ok(page2.every((e) => e.raw_offset > 0 && e.raw_length > 0));
			const bytes = Buffer.from(content);
			const first = page1[0];
			assert.equal(
				JSON.parse(bytes.subarray(first.raw_offset, first.raw_offset + first.raw_length).toString("utf8")).id,
				"m0",
			);
			assert.equal(readEntries(db, TEST_SESSION_ID, 0.5, 1.5).length, 1);
		} finally {
			db.close();
		}
	});

	it("lists sessions by state and reports stats", () => {
		const db = openArchiveDb(":memory:");
		try {
			importSessionPending(db, importFromContent(richSessionJsonl()));
			const otherContent = sessionJsonl([messageEntry("u1", null, userMessage("second session"))], {
				id: "aaaaaaaa-1111-4222-8333-444444444444",
			});
			importSessionPending(db, importFromContent(otherContent, { archivePath: "/archive/other/session.jsonl" }));
			markError(db, "aaaaaaaa-1111-4222-8333-444444444444", "test error");
			const stats = getArchiveStats(db);
			assert.equal(stats.sessionsPending, 1);
			assert.equal(stats.sessionsError, 1);
			assert.equal(listSessionRows(db, { state: "error" }).length, 1);
		} finally {
			db.close();
		}
	});

	it("serializes concurrent imports from two processes without duplicates", { timeout: 30000 }, async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const worker = `
			const { openArchiveDb, importSessionPending, finalizeArchived } = await import(${JSON.stringify(new URL("archive-store.ts", import.meta.url).href)});
			const { parseSessionJsonl, sha256Hex } = await import(${JSON.stringify(new URL("session-jsonl.ts", import.meta.url).href)});
			const { readFileSync } = await import("node:fs");
			const [dbPath, fixturePath] = process.argv.slice(-2);
			const content = readFileSync(fixturePath, "utf8");
			const parsed = parseSessionJsonl(content);
			for (let i = 0; i < 10; i++) {
				const db = openArchiveDb(dbPath);
				importSessionPending(db, {
					header: parsed.header, entries: parsed.entries,
					originalPath: "/active/session.jsonl", archivePath: "/archive/x/session.jsonl",
					fileSize: content.length, sha256: sha256Hex(content),
				});
				finalizeArchived(db, parsed.header.id, "/archive/x/session.jsonl", content.length, sha256Hex(content));
				db.close();
			}
		`;
		const fixture = join(tree.root, "fixture.jsonl");
		writeFileSync(fixture, content);
		const spawnWorker = () =>
			new Promise<void>((resolvePromise, rejectPromise) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", worker, tree.dbPath, fixture]);
				let stderr = "";
				child.stderr.on("data", (d) => (stderr += d));
				child.on("exit", (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(stderr))));
			});
		await Promise.all([spawnWorker(), spawnWorker()]);
		const db = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getArchiveStats(db).sessionsArchived, 1);
			assert.equal(countEntries(db, TEST_SESSION_ID), 12);
			assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "archived");
		} finally {
			db.close();
		}
	});

	it("enforces foreign keys on entry inserts", () => {
		const db = openArchiveDb(":memory:");
		try {
			assert.throws(() =>
				db
					.prepare("INSERT INTO archive_entries (session_id, entry_id, entry_type, timestamp, ordinal, raw_offset, raw_length) VALUES ('ghost', 'e', 'message', 't', 0, 0, 2)")
					.run(),
			);
		} finally {
			db.close();
		}
	});

	it("rejects a conflicting pending import without changing entries or FTS", () => {
		const db = openArchiveDb(":memory:");
		try {
			importSessionPending(db, importFromContent(richSessionJsonl()));
			const conflicting = richSessionJsonl().replace("hello archive world", "goodbye archive world");
			assert.throws(
				() => importSessionPending(db, importFromContent(conflicting)),
				/different pending archive operation/,
			);
			const matchCount = (query: string) =>
				(db.prepare("SELECT COUNT(*) AS n FROM archive_entries_fts WHERE archive_entries_fts MATCH ?").get(query) as { n: number }).n;
			assert.ok(matchCount("hello") > 0);
			assert.equal(matchCount("goodbye"), 0);
		} finally {
			db.close();
		}
	});

	it("opens a file-backed database at a nested path with directories created", () => {
		const tree = makeTempTree();
		const nested = join(tree.root, "deep", "nested", "archive.sqlite3");
		const db = openArchiveDb(nested);
		importSessionPending(db, importFromContent(richSessionJsonl()));
		db.close();
		const db2 = openArchiveDb(nested);
		assert.equal(getArchiveStats(db2).sessionsPending, 1);
		db2.close();
	});
});
