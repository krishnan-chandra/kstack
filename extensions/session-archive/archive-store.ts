/**
 * SQLite catalog for the session archive: schema initialization, transactional
 * imports, FTS, source byte references, and SELECT-only query helpers. Raw
 * JSON stays only in the canonical archived JSONL. Uses node:sqlite (Node 22+)
 * with no native dependency. Connections are short-lived: open per operation, close
 * in finally, so nothing survives session replacement.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ParsedEntry, ParsedSessionHeader } from "./session-jsonl.ts";

export class ArchiveStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveStoreError";
	}
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE archive_sessions (
  session_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  original_path TEXT NOT NULL,
  archive_path TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'archived', 'error')),
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  last_error TEXT
);

CREATE TABLE archive_entries (
  rowid INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES archive_sessions(session_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  parent_id TEXT,
  entry_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  role TEXT,
  text_content TEXT,
  raw_offset INTEGER NOT NULL,
  raw_length INTEGER NOT NULL,
  UNIQUE(session_id, entry_id),
  UNIQUE(session_id, ordinal)
);

CREATE VIRTUAL TABLE archive_entries_fts USING fts5(
  text_content,
  content='archive_entries',
  content_rowid='rowid'
);
CREATE TRIGGER archive_entries_ai AFTER INSERT ON archive_entries BEGIN
  INSERT INTO archive_entries_fts(rowid, text_content) VALUES (new.rowid, new.text_content);
END;
CREATE TRIGGER archive_entries_ad AFTER DELETE ON archive_entries BEGIN
  INSERT INTO archive_entries_fts(archive_entries_fts, rowid, text_content)
    VALUES('delete', old.rowid, old.text_content);
END;
`;

export function openArchiveDb(dbPath: string): DatabaseSync {
	if (dbPath !== ":memory:") {
		mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
	}
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA busy_timeout=5000");
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("PRAGMA foreign_keys=ON");
		initializeSchema(db);
		if (dbPath !== ":memory:") {
			try {
				chmodSync(dbPath, 0o600);
			} catch {
				// Best effort on platforms without POSIX modes.
			}
		}
		return db;
	} catch (err) {
		db.close();
		throw err;
	}
}

/** Open an existing archive without creating or modifying it. */
export function openArchiveDbReadOnly(dbPath: string): DatabaseSync {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		db.exec("PRAGMA query_only=ON");
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (row.user_version !== SCHEMA_VERSION) {
			throw new ArchiveStoreError(
				`unsupported archive schema version ${row.user_version} (expected ${SCHEMA_VERSION})`,
			);
		}
		return db;
	} catch (err) {
		db.close();
		throw err;
	}
}

function initializeSchema(db: DatabaseSync): void {
	const fast = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (fast.user_version === SCHEMA_VERSION) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		// Another process may have initialized the schema while this process waited for the lock.
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (row.user_version === SCHEMA_VERSION) {
			db.exec("COMMIT");
			return;
		}
		if (row.user_version !== 0) {
			throw new ArchiveStoreError(
				`unsupported archive schema version ${row.user_version} (expected ${SCHEMA_VERSION})`,
			);
		}
		db.exec(SCHEMA_SQL);
		db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

export interface PendingImport {
	header: ParsedSessionHeader;
	entries: ParsedEntry[];
	originalPath: string;
	/** Intended archive destination; recorded while pending so reconciliation can finish an interrupted move. */
	archivePath: string;
	fileSize: number;
	sha256: string;
	name?: string;
}

/**
 * Transactionally insert or replace a session's indexed content in state
 * 'pending'. Idempotent: re-running replaces entries wholesale. If the
 * session is already 'archived', the import is skipped when the hash matches
 * and rejected when it does not (same session id, different bytes = drift).
 */
export function importSessionPending(db: DatabaseSync, input: PendingImport): "imported" | "already-archived" {
	db.exec("BEGIN IMMEDIATE");
	try {
		const existing = db
			.prepare("SELECT state, sha256, archive_path FROM archive_sessions WHERE session_id = ?")
			.get(input.header.id) as { state: string; sha256: string; archive_path: string | null } | undefined;

		if (existing?.state === "archived") {
			if (existing.sha256 !== input.sha256 || existing.archive_path !== input.archivePath) {
				throw new ArchiveStoreError(
					`session ${input.header.id} is already archived with different content or destination`,
				);
			}
			db.exec("COMMIT");
			return "already-archived";
		}
		if (
			existing?.state === "pending" &&
			(existing.sha256 !== input.sha256 || existing.archive_path !== input.archivePath)
		) {
			throw new ArchiveStoreError(`session ${input.header.id} already has a different pending archive operation`);
		}

		const indexedName = latestSessionName(input.entries);
		const sessionName = input.name !== undefined ? input.name : indexedName === undefined ? null : indexedName;
		db.prepare(
			`INSERT INTO archive_sessions (
			   session_id, cwd, name, created_at, archived_at, original_path,
			   archive_path, state, file_size, sha256, entry_count, last_error
			 ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending', ?, ?, ?, NULL)
			 ON CONFLICT(session_id) DO UPDATE SET
			   cwd=excluded.cwd, name=excluded.name, created_at=excluded.created_at,
			   archived_at=NULL, original_path=excluded.original_path,
			   archive_path=excluded.archive_path, state='pending', file_size=excluded.file_size,
			   sha256=excluded.sha256, entry_count=excluded.entry_count, last_error=NULL`,
		).run(
			input.header.id,
			input.header.cwd,
			sessionName,
			input.header.timestamp,
			input.originalPath,
			input.archivePath,
			input.fileSize,
			input.sha256,
			input.entries.length,
		);

		db.prepare("DELETE FROM archive_entries WHERE session_id = ?").run(input.header.id);
		const insert = db.prepare(
			`INSERT INTO archive_entries (
			   session_id, entry_id, parent_id, entry_type, timestamp, ordinal,
			   role, text_content, raw_offset, raw_length
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const entry of input.entries) {
			insert.run(
				input.header.id,
				entry.entryId,
				entry.parentId,
				entry.entryType,
				entry.timestamp,
				entry.ordinal,
				entry.role ?? null,
				entry.textContent ?? null,
				entry.rawOffset,
				entry.rawLength,
			);
		}
		db.exec("COMMIT");
		return "imported";
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function latestSessionName(entries: ParsedEntry[]): string | null | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].sessionNamePresent) return entries[i].sessionName ?? null;
	}
	return undefined;
}

/** Mark a pending session archived after its file is safely in place. */
export function finalizeArchived(
	db: DatabaseSync,
	sessionId: string,
	archivePath: string,
	fileSize: number,
	sha256: string,
): "finalized" | "already-archived" {
	db.exec("BEGIN IMMEDIATE");
	try {
		const existing = db
			.prepare("SELECT state, archive_path, sha256 FROM archive_sessions WHERE session_id = ?")
			.get(sessionId) as { state: string; archive_path: string | null; sha256: string } | undefined;
		if (!existing) {
			throw new ArchiveStoreError(`cannot finalize unknown session ${sessionId}`);
		}
		if (existing.state === "archived") {
			if (existing.archive_path !== archivePath || existing.sha256 !== sha256) {
				throw new ArchiveStoreError(`session ${sessionId} is archived at a different path or with different content`);
			}
			db.exec("COMMIT");
			return "already-archived";
		}
		if (existing.state !== "pending") {
			throw new ArchiveStoreError(`cannot finalize session ${sessionId} from state ${existing.state}`);
		}
		if (existing.archive_path !== archivePath || existing.sha256 !== sha256) {
			throw new ArchiveStoreError(`pending session ${sessionId} no longer matches this finalization operation`);
		}
		const update = db
			.prepare(
				`UPDATE archive_sessions
			   SET state='archived', archived_at=?, file_size=?, last_error=NULL
			 WHERE session_id=? AND state='pending' AND archive_path=? AND sha256=?`,
			)
			.run(new Date().toISOString(), fileSize, sessionId, archivePath, sha256);
		if (update.changes !== 1) {
			throw new ArchiveStoreError(`session ${sessionId} changed while it was being finalized`);
		}
		db.exec("COMMIT");
		return "finalized";
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

export function discardPendingImport(db: DatabaseSync, sessionId: string, archivePath: string, sha256: string): void {
	db.prepare(
		"DELETE FROM archive_sessions WHERE session_id = ? AND state = 'pending' AND archive_path = ? AND sha256 = ?",
	).run(sessionId, archivePath, sha256);
}

export function markError(db: DatabaseSync, sessionId: string, message: string): void {
	db.prepare("UPDATE archive_sessions SET state='error', last_error=? WHERE session_id=?").run(
		message.slice(0, 2000),
		sessionId,
	);
}

interface ArchiveSessionRow {
	session_id: string;
	cwd: string;
	name: string | null;
	created_at: string;
	archived_at: string | null;
	original_path: string;
	archive_path: string | null;
	state: "pending" | "archived" | "error";
	file_size: number;
	sha256: string;
	entry_count: number;
	last_error: string | null;
}

export function getSessionRow(db: DatabaseSync, sessionId: string): ArchiveSessionRow | undefined {
	return db.prepare("SELECT * FROM archive_sessions WHERE session_id = ?").get(sessionId) as
		| ArchiveSessionRow
		| undefined;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

export function listSessionRows(db: DatabaseSync, opts: { state?: string; limit?: number } = {}): ArchiveSessionRow[] {
	const limit = boundedInteger(opts.limit, 100, 1, 1000);
	if (opts.state) {
		return db
			.prepare("SELECT * FROM archive_sessions WHERE state = ? ORDER BY created_at DESC LIMIT ?")
			.all(opts.state, limit) as unknown as ArchiveSessionRow[];
	}
	return db
		.prepare("SELECT * FROM archive_sessions ORDER BY created_at DESC LIMIT ?")
		.all(limit) as unknown as ArchiveSessionRow[];
}

interface SearchHit {
	session_id: string;
	entry_id: string;
	entry_type: string;
	role: string | null;
	timestamp: string;
	cwd: string;
	session_name: string | null;
	archived_at: string | null;
	snippet: string;
}

export class FtsQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FtsQueryError";
	}
}

/** FTS5 search. The query is FTS syntax but always bound, never interpolated. */
export function searchArchive(
	db: DatabaseSync,
	opts: {
		query: string;
		cwd?: string;
		role?: string;
		sessionId?: string;
		limit?: number;
	},
): SearchHit[] {
	const limit = boundedInteger(opts.limit, 20, 1, 100);
	const statement = db.prepare(
		`SELECT e.session_id, e.entry_id, e.entry_type, e.role, e.timestamp,
		        s.cwd, s.name AS session_name, s.archived_at,
		        snippet(archive_entries_fts, 0, '[', ']', '…', 32) AS snippet
		   FROM archive_entries_fts
		   JOIN archive_entries e ON e.rowid = archive_entries_fts.rowid
		   JOIN archive_sessions s ON s.session_id = e.session_id
		  WHERE archive_entries_fts MATCH ?
		    AND s.state = 'archived'
		    AND (? IS NULL OR s.cwd = ?)
		    AND (? IS NULL OR e.role = ?)
		    AND (? IS NULL OR e.session_id = ?)
		  ORDER BY rank
		  LIMIT ?`,
	);
	try {
		return statement.all(
			opts.query,
			opts.cwd ?? null,
			opts.cwd ?? null,
			opts.role ?? null,
			opts.role ?? null,
			opts.sessionId ?? null,
			opts.sessionId ?? null,
			limit,
		) as unknown as SearchHit[];
	} catch (err) {
		const message = (err as Error).message;
		if (/fts5:|unterminated string|no such column:/i.test(message)) {
			throw new FtsQueryError(
				`invalid FTS5 query ${JSON.stringify(opts.query)}: ${message}. ` +
					'Use plain words, "quoted phrases", AND/OR/NOT, or prefix* terms.',
			);
		}
		throw err;
	}
}

interface ArchiveEntryRow {
	entry_id: string;
	parent_id: string | null;
	entry_type: string;
	timestamp: string;
	ordinal: number;
	role: string | null;
	text_content: string | null;
	raw_offset: number;
	raw_length: number;
}

export function countEntries(db: DatabaseSync, sessionId: string): number {
	const row = db.prepare("SELECT COUNT(*) AS n FROM archive_entries WHERE session_id = ?").get(sessionId) as {
		n: number;
	};
	return row.n;
}

export function readEntries(db: DatabaseSync, sessionId: string, offset: number, limit: number): ArchiveEntryRow[] {
	const safeOffset = boundedInteger(offset, 0, 0, 2_147_483_647);
	const safeLimit = boundedInteger(limit, 50, 1, 200);
	return db
		.prepare(
			`SELECT entry_id, parent_id, entry_type, timestamp, ordinal,
			        role, text_content, raw_offset, raw_length
			   FROM archive_entries
			  WHERE session_id = ?
			  ORDER BY ordinal
			  LIMIT ? OFFSET ?`,
		)
		.all(sessionId, safeLimit, safeOffset) as unknown as ArchiveEntryRow[];
}

interface ArchiveStats {
	sessionsArchived: number;
	sessionsPending: number;
	sessionsError: number;
	entriesTotal: number;
}

export function getArchiveStats(db: DatabaseSync): ArchiveStats {
	const byState = db.prepare("SELECT state, COUNT(*) AS n FROM archive_sessions GROUP BY state").all() as unknown as {
		state: string;
		n: number;
	}[];
	const entries = db.prepare("SELECT COUNT(*) AS n FROM archive_entries").get() as { n: number };
	const count = (state: string) => byState.find((r) => r.state === state)?.n ?? 0;
	return {
		sessionsArchived: count("archived"),
		sessionsPending: count("pending"),
		sessionsError: count("error"),
		entriesTotal: entries.n,
	};
}
