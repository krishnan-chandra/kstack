import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { BoundaryValue } from "../shared/validation.ts";
import { parseSessionJsonl } from "./session-jsonl.ts";
import {
	deleteIndexedSubagentSessions,
	getIndexedSubagentSession,
	getSubagentHistoryDbPath,
	type IndexedSubagentSessionInput,
	listIndexedSubagentSessions,
	openSubagentHistoryStore,
	readIndexedSubagentEntries,
	replaceIndexedSubagentSession,
	SubagentHistoryFtsQueryError,
	SubagentHistoryStoreError,
	searchIndexedSubagentHistory,
} from "./subagent-history-store.ts";
import { messageEntry, richSessionJsonl, sessionJsonl, userMessage } from "./test-helpers.ts";

const ID = "019ff001-deb2-7696-997e-8684026835d1";

function input(
	content = richSessionJsonl(),
	overrides: Partial<IndexedSubagentSessionInput> = {},
): IndexedSubagentSessionInput {
	const parsed = parseSessionJsonl(content);
	return {
		sessionId: parsed.header.id.toLowerCase(),
		header: parsed.header,
		entries: parsed.entries,
		relativeFilename: `2026-08-11T08-48-02-226Z_${parsed.header.id}.jsonl`,
		signature: { size: Buffer.byteLength(content), mtimeMs: 123.5, inode: 44 },
		name: parsed.entries.findLast((entry) => entry.sessionNamePresent)?.sessionName ?? null,
		...overrides,
	};
}

function tempStore() {
	const root = mkdtempSync(join(tmpdir(), "kstack-subagent-history-store-"));
	const agentDir = join(root, "agent");
	const dbPath = getSubagentHistoryDbPath(agentDir);
	return { root, agentDir, dbPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withMemory(run: (db: DatabaseSync) => void): void {
	const db = openSubagentHistoryStore(":memory:");
	try {
		run(db);
	} finally {
		db.close();
	}
}

describe("subagent history store", () => {
	it("indexes phrase and prefix queries with exact filters and strict metadata", () => {
		withMemory((db) => {
			replaceIndexedSubagentSession(db, input());
			assert.ok(searchIndexedSubagentHistory(db, { query: '"hello archive"' }).some((hit) => hit.entryId === "u1"));
			assert.ok(searchIndexedSubagentHistory(db, { query: "archiv*" }).length > 0);
			assert.ok(searchIndexedSubagentHistory(db, { query: "archive", cwd: "/Users/test/Code/project" }).length > 0);
			assert.equal(searchIndexedSubagentHistory(db, { query: "archive", cwd: "/other" }).length, 0);
			assert.ok(
				searchIndexedSubagentHistory(db, { query: "archive", role: "user" }).every((hit) => hit.role === "user"),
			);
			assert.ok(searchIndexedSubagentHistory(db, { query: "archive", sessionId: ID }).length > 0);
			assert.equal(
				searchIndexedSubagentHistory(db, { query: "archive", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })
					.length,
				0,
			);
			const row = getIndexedSubagentSession(db, ID);
			assert.equal(row?.name, "archive test session");
			assert.equal(row?.relativeFilename, `2026-08-11T08-48-02-226Z_${ID}.jsonl`);
			assert.deepEqual(row?.signature, { size: Buffer.byteLength(richSessionJsonl()), mtimeMs: 123.5, inode: 44 });
		});
	});

	it("keys rows on the canonical session ID and pages ranked hits by offset", () => {
		withMemory((db) => {
			const upper = input(richSessionJsonl(), { sessionId: ID });
			upper.header = { ...upper.header, id: ID.toUpperCase() };
			replaceIndexedSubagentSession(db, upper);
			assert.equal(getIndexedSubagentSession(db, ID)?.sessionId, ID);
			assert.equal(getIndexedSubagentSession(db, ID.toUpperCase()), undefined);
			const all = searchIndexedSubagentHistory(db, { query: "archive", limit: 100 });
			assert.ok(all.length >= 2);
			assert.ok(all.every((hit) => hit.sessionId === ID));
			const first = searchIndexedSubagentHistory(db, { query: "archive", limit: 1, offset: 0 });
			const second = searchIndexedSubagentHistory(db, { query: "archive", limit: 1, offset: 1 });
			assert.deepEqual([first[0].entryId, second[0].entryId], [all[0].entryId, all[1].entryId]);
			assert.equal(searchIndexedSubagentHistory(db, { query: "archive", limit: 10, offset: all.length }).length, 0);
		});
	});

	it("replaces entries atomically and removes stale FTS text", () => {
		withMemory((db) => {
			replaceIndexedSubagentSession(db, input());
			const replacement = sessionJsonl([messageEntry("new", null, userMessage("replacement needle"))]);
			replaceIndexedSubagentSession(
				db,
				input(replacement, {
					signature: { size: Buffer.byteLength(replacement), mtimeMs: 124, inode: 44 },
					name: null,
				}),
			);
			assert.equal(searchIndexedSubagentHistory(db, { query: "archiving" }).length, 0);
			assert.equal(searchIndexedSubagentHistory(db, { query: "replacement" })[0]?.entryId, "new");
			assert.equal(readIndexedSubagentEntries(db, ID, 0, 100).length, 1);
		});
	});

	it("deletes session, entry, and FTS rows together", () => {
		withMemory((db) => {
			replaceIndexedSubagentSession(db, input());
			deleteIndexedSubagentSessions(db, [ID, ID]);
			assert.equal(getIndexedSubagentSession(db, ID), undefined);
			assert.equal(readIndexedSubagentEntries(db, ID, 0, 100).length, 0);
			assert.equal(searchIndexedSubagentHistory(db, { query: "archive" }).length, 0);
		});
	});

	it("preserves original ordinals and byte ranges", () => {
		withMemory((db) => {
			const content = richSessionJsonl();
			replaceIndexedSubagentSession(db, input(content));
			const entries = readIndexedSubagentEntries(db, ID, 2, 3);
			assert.deepEqual(
				entries.map((entry) => entry.ordinal),
				[2, 3, 4],
			);
			const bytes = Buffer.from(content);
			for (const entry of entries) {
				const raw = bytes.subarray(entry.rawOffset, entry.rawOffset + entry.rawLength).toString("utf8");
				assert.equal(JSON.parse(raw).id, entry.entryId);
			}
		});
	});

	it("reports malformed FTS separately from operational cache failures", () => {
		withMemory((db) => {
			replaceIndexedSubagentSession(db, input());
			assert.throws(() => searchIndexedSubagentHistory(db, { query: "foo AND" }), SubagentHistoryFtsQueryError);
			db.exec("DROP TABLE subagent_entries_fts");
			assert.throws(
				() => searchIndexedSubagentHistory(db, { query: "valid" }),
				(error: BoundaryValue) => error instanceof Error && !(error instanceof SubagentHistoryFtsQueryError),
			);
		});
	});

	it("rolls back a failed replacement without stale or partial replacement text", () => {
		withMemory((db) => {
			replaceIndexedSubagentSession(db, input());
			const broken = input();
			broken.entries = broken.entries.map((entry, index) =>
				index === 3 ? { ...entry, entryId: broken.entries[0].entryId, textContent: "partial-only-marker" } : entry,
			);
			assert.throws(() => replaceIndexedSubagentSession(db, broken));
			assert.ok(searchIndexedSubagentHistory(db, { query: "archiving" }).length > 0);
			assert.equal(searchIndexedSubagentHistory(db, { query: '"partial-only-marker"' }).length, 0);
		});
	});

	it("reopens file-backed cache metadata with owner-only modes", () => {
		const fx = tempStore();
		try {
			let db = openSubagentHistoryStore(fx.dbPath);
			replaceIndexedSubagentSession(db, input());
			db.close();
			assert.ok(existsSync(fx.dbPath));
			if (process.platform !== "win32") {
				assert.equal(lstatSync(fx.dbPath).mode & 0o777, 0o600);
				assert.equal(lstatSync(join(fx.agentDir, "cache", "kstack-subagent-history")).mode & 0o777, 0o700);
			}
			db = openSubagentHistoryStore(fx.dbPath);
			assert.equal(listIndexedSubagentSessions(db)[0]?.sessionId, ID);
			assert.ok(searchIndexedSubagentHistory(db, { query: "archive" }).length > 0);
			db.close();
		} finally {
			fx.cleanup();
		}
	});

	it("rejects cache directory and database symlinks", () => {
		const dirFx = tempStore();
		try {
			mkdirSync(join(dirFx.agentDir, "cache"), { recursive: true });
			const target = join(dirFx.root, "outside");
			mkdirSync(target);
			symlinkSync(target, join(dirFx.agentDir, "cache", "kstack-subagent-history"));
			assert.throws(() => openSubagentHistoryStore(dirFx.dbPath), SubagentHistoryStoreError);
		} finally {
			dirFx.cleanup();
		}

		const fileFx = tempStore();
		try {
			const cacheDir = join(fileFx.agentDir, "cache", "kstack-subagent-history");
			mkdirSync(cacheDir, { recursive: true });
			const target = join(fileFx.root, "outside.sqlite3");
			const targetDb = openSubagentHistoryStore(target);
			targetDb.close();
			symlinkSync(target, fileFx.dbPath);
			assert.throws(() => openSubagentHistoryStore(fileFx.dbPath), SubagentHistoryStoreError);
		} finally {
			fileFx.cleanup();
		}
	});

	it("rejects unsupported and corrupt cache schemas explicitly", () => {
		const fx = tempStore();
		try {
			let db = openSubagentHistoryStore(fx.dbPath);
			db.exec("PRAGMA user_version=99");
			db.close();
			assert.throws(() => openSubagentHistoryStore(fx.dbPath), /unsupported subagent history cache schema version 99/);
			db = new DatabaseSync(fx.dbPath);
			db.exec("PRAGMA user_version=1; DROP TABLE subagent_sessions");
			db.close();
			assert.throws(() => openSubagentHistoryStore(fx.dbPath), /schema is corrupt/);
		} finally {
			fx.cleanup();
		}
	});

	it("uses SQLite busy handling and leaves committed rows intact on contention", { timeout: 10_000 }, () => {
		const fx = tempStore();
		try {
			const first = openSubagentHistoryStore(fx.dbPath);
			const second = openSubagentHistoryStore(fx.dbPath);
			try {
				replaceIndexedSubagentSession(first, input());
				first.exec("BEGIN IMMEDIATE");
				assert.throws(() => deleteIndexedSubagentSessions(second, [ID]), /busy|locked/i);
				first.exec("ROLLBACK");
				assert.equal(getIndexedSubagentSession(first, ID)?.sessionId, ID);
			} finally {
				if (first.isTransaction) first.exec("ROLLBACK");
				first.close();
				second.close();
			}
		} finally {
			fx.cleanup();
		}
	});
});
