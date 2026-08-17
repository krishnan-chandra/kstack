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
import { asRecord } from "../shared/narrow.ts";
import type { ParsedEntry, ParsedSessionHeader } from "./session-jsonl.ts";

export class ArchiveStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveStoreError";
	}
}

const SCHEMA_VERSION = 3;
const SQLITE_BUSY = 5;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const JOURNAL_MODE_RETRY_MS = 10;
const RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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
  last_error TEXT,
  verified_at INTEGER,
  verified_mtime_ms REAL
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

CREATE TABLE archive_restore_journal (
  session_id TEXT PRIMARY KEY REFERENCES archive_sessions(session_id) ON DELETE CASCADE,
  original_path TEXT NOT NULL, archive_path TEXT NOT NULL,
  sha256 TEXT NOT NULL, file_size INTEGER NOT NULL, started_at TEXT NOT NULL
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
		db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
		ensureWalJournalMode(db, dbPath);
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

/**
 * WAL mode persists in the database, so established archives need only read
 * the pragma. Two first-time openers can still race while changing it; SQLite
 * may report BUSY there before the connection's busy timeout takes effect.
 */
function ensureWalJournalMode(db: DatabaseSync, dbPath: string): void {
	if (dbPath === ":memory:") return;

	const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
	while (true) {
		try {
			const current = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
			if (current.journal_mode === "wal") return;

			const changed = db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode: string };
			if (changed.journal_mode === "wal") return;
			throw new ArchiveStoreError(`failed to enable WAL journal mode (SQLite reported ${changed.journal_mode})`);
		} catch (err) {
			const sqliteError = asRecord(err);
			if (sqliteError?.errcode !== SQLITE_BUSY || Date.now() >= deadline) throw err;
			Atomics.wait(RETRY_SIGNAL, 0, 0, JOURNAL_MODE_RETRY_MS);
		}
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
			   archive_path, state, file_size, sha256, entry_count, last_error,
			   verified_at, verified_mtime_ms
			 ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL)
			 ON CONFLICT(session_id) DO UPDATE SET
			   cwd=excluded.cwd, name=excluded.name, created_at=excluded.created_at,
			   archived_at=NULL, original_path=excluded.original_path,
			   archive_path=excluded.archive_path, state='pending', file_size=excluded.file_size,
			   sha256=excluded.sha256, entry_count=excluded.entry_count, last_error=NULL,
			   verified_at=NULL, verified_mtime_ms=NULL`,
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

interface RestoreJournalRow {
	session_id: string;
	original_path: string;
	archive_path: string;
	sha256: string;
	file_size: number;
}

/** Record a restore before moving bytes, making interrupted restores recoverable. */
export function beginRestore(db: DatabaseSync, sessionId: string): RestoreJournalRow {
	db.exec("BEGIN IMMEDIATE");
	try {
		const row = db
			.prepare(`SELECT session_id, original_path, archive_path, sha256, file_size, state
			FROM archive_sessions WHERE session_id = ?`)
			.get(sessionId);
		if (!row) throw new ArchiveStoreError(`cannot restore unknown session ${sessionId}`);
		const stateRow = asRecord(row);
		if (!stateRow) throw new ArchiveStoreError(`invalid archived session ${sessionId}`);
		const state = decodeString(stateRow, "archive_sessions", "state");
		if (state !== "archived") throw new ArchiveStoreError(`cannot restore session ${sessionId} from state ${state}`);
		const archivePath = decodeNullableString(stateRow, "archive_sessions", "archive_path");
		if (!archivePath) throw new ArchiveStoreError(`archived session ${sessionId} has no archive path`);
		const journal: RestoreJournalRow = {
			session_id: decodeString(stateRow, "archive_sessions", "session_id"),
			original_path: decodeString(stateRow, "archive_sessions", "original_path"),
			archive_path: archivePath,
			sha256: decodeString(stateRow, "archive_sessions", "sha256"),
			file_size: decodeFiniteNumber(stateRow, "archive_sessions", "file_size"),
		};
		db.prepare(`INSERT INTO archive_restore_journal (session_id, original_path, archive_path, sha256, file_size, started_at)
			VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`).run(
			journal.session_id,
			journal.original_path,
			journal.archive_path,
			journal.sha256,
			journal.file_size,
			new Date().toISOString(),
		);
		db.exec("COMMIT");
		return journal;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

/** Remove restored catalog content and its journal atomically, including FTS trigger cleanup. */
export function finishRestore(db: DatabaseSync, sessionId: string): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		// Delete explicitly so FTS cleanup never depends on cascade-trigger behavior.
		db.prepare("DELETE FROM archive_entries WHERE session_id = ?").run(sessionId);
		db.prepare("DELETE FROM archive_sessions WHERE session_id = ?").run(sessionId);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

export function listRestoreJournals(db: DatabaseSync): RestoreJournalRow[] {
	return decodeRows(
		db.prepare("SELECT session_id, original_path, archive_path, sha256, file_size FROM archive_restore_journal").all(),
		(value) => {
			const row = asRecord(value);
			if (!row) throw new ArchiveStoreError("archive_restore_journal returned a non-object row");
			return {
				session_id: decodeString(row, "archive_restore_journal", "session_id"),
				original_path: decodeString(row, "archive_restore_journal", "original_path"),
				archive_path: decodeString(row, "archive_restore_journal", "archive_path"),
				sha256: decodeString(row, "archive_restore_journal", "sha256"),
				file_size: decodeFiniteNumber(row, "archive_restore_journal", "file_size"),
			};
		},
	);
}

export interface ArchivedSessionSummary {
	state: "archived" | "error";
	sessionId: string;
	cwd: string;
	name: string | null;
	firstUserText: string | null;
	messageCount: number;
	originalPath: string;
	archivePath: string | null;
	lastError: string | null;
	createdAt: string;
	lastMessageAt: string | null;
}

/** Archived and recovery-error rows needed by the unified session browser. */
export function listArchivedSessionSummaries(db: DatabaseSync): ArchivedSessionSummary[] {
	return decodeRows(
		db
			.prepare(`SELECT s.session_id, s.cwd, s.name, s.original_path, s.archive_path, s.created_at, s.state, s.last_error,
		(SELECT e.text_content FROM archive_entries e WHERE e.session_id=s.session_id AND e.role='user' ORDER BY e.ordinal LIMIT 1) AS first_user_text,
		(SELECT COUNT(*) FROM archive_entries e WHERE e.session_id=s.session_id AND e.entry_type='message') AS message_count,
		(SELECT MAX(e.timestamp) FROM archive_entries e WHERE e.session_id=s.session_id AND e.role IN ('user', 'assistant')) AS last_message_at
		FROM archive_sessions s WHERE s.state IN ('archived', 'error')`)
			.all(),
		(value) => {
			const row = asRecord(value);
			if (!row) throw new ArchiveStoreError("archive summary returned a non-object row");
			const state = decodeString(row, "archive summary", "state");
			const common = {
				sessionId: decodeString(row, "archive summary", "session_id"),
				cwd: decodeString(row, "archive summary", "cwd"),
				name: decodeNullableString(row, "archive summary", "name"),
				firstUserText: decodeNullableString(row, "archive summary", "first_user_text"),
				messageCount: decodeFiniteNumber(row, "archive summary", "message_count"),
				originalPath: decodeString(row, "archive summary", "original_path"),
				createdAt: decodeString(row, "archive summary", "created_at"),
				lastMessageAt: decodeNullableString(row, "archive summary", "last_message_at"),
			};
			if (state !== "archived" && state !== "error") {
				throw new ArchiveStoreError(`archive summary returned invalid state ${JSON.stringify(state)}`);
			}
			return {
				...common,
				state,
				archivePath: decodeNullableString(row, "archive summary", "archive_path"),
				lastError: decodeNullableString(row, "archive summary", "last_error"),
			};
		},
	);
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
	verified_at: number | null;
	verified_mtime_ms: number | null;
}

function decodeString(row: Record<string, unknown>, table: string, column: string): string {
	const value = row[column];
	if (typeof value !== "string") throw new Error(`${table} returned invalid ${column}.`);
	return value;
}

function decodeNullableString(row: Record<string, unknown>, table: string, column: string): string | null {
	const value = row[column];
	if (value !== null && typeof value !== "string") throw new Error(`${table} returned invalid ${column}.`);
	return value;
}

function decodeFiniteNumber(row: Record<string, unknown>, table: string, column: string): number {
	const value = row[column];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${table} returned invalid ${column}.`);
	return value;
}

function decodeNullableFiniteNumber(row: Record<string, unknown>, table: string, column: string): number | null {
	const value = row[column];
	if (value === null || value === undefined) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${table} returned invalid ${column}.`);
	return value;
}

function decodeState(row: Record<string, unknown>, table: string): ArchiveSessionRow["state"] {
	const state = decodeString(row, table, "state");
	if (state === "pending" || state === "archived" || state === "error") return state;
	throw new Error(`${table} returned invalid state.`);
}

function decodeSessionRow(value: unknown): ArchiveSessionRow {
	const table = "archive_sessions";
	const row = asRecord(value);
	if (!row) throw new Error(`${table} returned a non-object row.`);
	return {
		session_id: decodeString(row, table, "session_id"),
		cwd: decodeString(row, table, "cwd"),
		name: decodeNullableString(row, table, "name"),
		created_at: decodeString(row, table, "created_at"),
		archived_at: decodeNullableString(row, table, "archived_at"),
		original_path: decodeString(row, table, "original_path"),
		archive_path: decodeNullableString(row, table, "archive_path"),
		state: decodeState(row, table),
		file_size: decodeFiniteNumber(row, table, "file_size"),
		sha256: decodeString(row, table, "sha256"),
		entry_count: decodeFiniteNumber(row, table, "entry_count"),
		last_error: decodeNullableString(row, table, "last_error"),
		verified_at: decodeNullableFiniteNumber(row, table, "verified_at"),
		verified_mtime_ms: decodeNullableFiniteNumber(row, table, "verified_mtime_ms"),
	};
}

function decodeRows<T>(values: unknown[], decode: (value: unknown) => T): T[] {
	return values.map(decode);
}

export function getSessionRow(db: DatabaseSync, sessionId: string): ArchiveSessionRow | undefined {
	const row = db.prepare("SELECT * FROM archive_sessions WHERE session_id = ?").get(sessionId);
	return row === undefined ? undefined : decodeSessionRow(row);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

export function listSessionRows(db: DatabaseSync, opts: { state?: string; limit?: number } = {}): ArchiveSessionRow[] {
	const limit = boundedInteger(opts.limit, 100, 1, 1000);
	if (opts.state) {
		return decodeRows(
			db
				.prepare("SELECT * FROM archive_sessions WHERE state = ? ORDER BY created_at DESC LIMIT ?")
				.all(opts.state, limit),
			decodeSessionRow,
		);
	}
	return decodeRows(
		db.prepare("SELECT * FROM archive_sessions ORDER BY created_at DESC LIMIT ?").all(limit),
		decodeSessionRow,
	);
}

export interface ArchivedIntegrityRow {
	session_id: string;
	archive_path: string | null;
	sha256: string;
	file_size: number;
	verified_at: number | null;
	verified_mtime_ms: number | null;
}

function decodeArchivedIntegrityRow(value: unknown): ArchivedIntegrityRow {
	const table = "archive_sessions";
	const row = asRecord(value);
	if (!row) throw new Error(`${table} returned a non-object row.`);
	return {
		session_id: decodeString(row, table, "session_id"),
		archive_path: decodeNullableString(row, table, "archive_path"),
		sha256: decodeString(row, table, "sha256"),
		file_size: decodeFiniteNumber(row, table, "file_size"),
		verified_at: decodeNullableFiniteNumber(row, table, "verified_at"),
		verified_mtime_ms: decodeNullableFiniteNumber(row, table, "verified_mtime_ms"),
	};
}

export function listArchivedForIntegrity(db: DatabaseSync, limit?: number, sessionId?: string): ArchivedIntegrityRow[] {
	const columns = "session_id, archive_path, sha256, file_size, verified_at, verified_mtime_ms";
	if (sessionId !== undefined) {
		return decodeRows(
			db.prepare(`SELECT ${columns} FROM archive_sessions WHERE session_id = ? AND state = 'archived'`).all(sessionId),
			decodeArchivedIntegrityRow,
		);
	}
	const safeLimit = boundedInteger(limit, 200, 1, 1000);
	return decodeRows(
		db
			.prepare(
				`SELECT ${columns} FROM archive_sessions
				  WHERE state = 'archived' AND archive_path IS NOT NULL
				  ORDER BY created_at DESC
				  LIMIT ?`,
			)
			.all(safeLimit),
		decodeArchivedIntegrityRow,
	);
}

export function markVerified(db: DatabaseSync, sessionId: string, verifiedAt: number, mtimeMs: number): boolean {
	const result = db
		.prepare(
			"UPDATE archive_sessions SET verified_at = ?, verified_mtime_ms = ? WHERE session_id = ? AND state = 'archived'",
		)
		.run(verifiedAt, mtimeMs, sessionId);
	return Number(result.changes) === 1;
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

function decodeSearchHit(value: unknown): SearchHit {
	const table = "archive search";
	const row = asRecord(value);
	if (!row) throw new Error(`${table} returned a non-object row.`);
	return {
		session_id: decodeString(row, table, "session_id"),
		entry_id: decodeString(row, table, "entry_id"),
		entry_type: decodeString(row, table, "entry_type"),
		role: decodeNullableString(row, table, "role"),
		timestamp: decodeString(row, table, "timestamp"),
		cwd: decodeString(row, table, "cwd"),
		session_name: decodeNullableString(row, table, "session_name"),
		archived_at: decodeNullableString(row, table, "archived_at"),
		snippet: decodeString(row, table, "snippet"),
	};
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
		return decodeRows(
			statement.all(
				opts.query,
				opts.cwd ?? null,
				opts.cwd ?? null,
				opts.role ?? null,
				opts.role ?? null,
				opts.sessionId ?? null,
				opts.sessionId ?? null,
				limit,
			),
			decodeSearchHit,
		);
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

function decodeArchiveEntryRow(value: unknown): ArchiveEntryRow {
	const table = "archive_entries";
	const row = asRecord(value);
	if (!row) throw new Error(`${table} returned a non-object row.`);
	return {
		entry_id: decodeString(row, table, "entry_id"),
		parent_id: decodeNullableString(row, table, "parent_id"),
		entry_type: decodeString(row, table, "entry_type"),
		timestamp: decodeString(row, table, "timestamp"),
		ordinal: decodeFiniteNumber(row, table, "ordinal"),
		role: decodeNullableString(row, table, "role"),
		text_content: decodeNullableString(row, table, "text_content"),
		raw_offset: decodeFiniteNumber(row, table, "raw_offset"),
		raw_length: decodeFiniteNumber(row, table, "raw_length"),
	};
}

function decodeCount(value: unknown, table: string): number {
	const row = asRecord(value);
	if (!row) throw new Error(`${table} returned a non-object row.`);
	return decodeFiniteNumber(row, table, "n");
}

export function countEntries(db: DatabaseSync, sessionId: string): number {
	return decodeCount(
		db.prepare("SELECT COUNT(*) AS n FROM archive_entries WHERE session_id = ?").get(sessionId),
		"archive_entries",
	);
}

export function readEntries(db: DatabaseSync, sessionId: string, offset: number, limit: number): ArchiveEntryRow[] {
	const safeOffset = boundedInteger(offset, 0, 0, 2_147_483_647);
	const safeLimit = boundedInteger(limit, 50, 1, 200);
	return decodeRows(
		db
			.prepare(
				`SELECT entry_id, parent_id, entry_type, timestamp, ordinal,
			        role, text_content, raw_offset, raw_length
			   FROM archive_entries
			  WHERE session_id = ?
			  ORDER BY ordinal
			  LIMIT ? OFFSET ?`,
			)
			.all(sessionId, safeLimit, safeOffset),
		decodeArchiveEntryRow,
	);
}

interface ArchiveStats {
	sessionsArchived: number;
	sessionsPending: number;
	sessionsError: number;
	entriesTotal: number;
}

export function getArchiveStats(db: DatabaseSync): ArchiveStats {
	const byState = decodeRows(
		db.prepare("SELECT state, COUNT(*) AS n FROM archive_sessions GROUP BY state").all(),
		(value) => {
			const table = "archive_sessions";
			const row = asRecord(value);
			if (!row) throw new Error(`${table} returned a non-object row.`);
			return { state: decodeState(row, table), n: decodeFiniteNumber(row, table, "n") };
		},
	);
	const entries = decodeCount(db.prepare("SELECT COUNT(*) AS n FROM archive_entries").get(), "archive_entries");
	const count = (state: ArchiveSessionRow["state"]) => byState.find((row) => row.state === state)?.n ?? 0;
	return {
		sessionsArchived: count("archived"),
		sessionsPending: count("pending"),
		sessionsError: count("error"),
		entriesTotal: entries,
	};
}
