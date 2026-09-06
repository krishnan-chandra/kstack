/** Disposable SQLite/FTS5 cache for retained child-session history. */
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "../shared/kstack-config.ts";
import { asRecord } from "../shared/narrow.ts";
import { type BoundaryValue, isNumber, isObject, isString, type JsonObject } from "../shared/validation.ts";
import type { ParsedEntry, ParsedSessionHeader } from "./session-jsonl.ts";
import type { SubagentFileSignature } from "./subagent-history-files.ts";

const SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const EXPECTED_SCHEMA_OBJECTS = new Set([
	"subagent_sessions",
	"subagent_entries",
	"subagent_entries_fts",
	"subagent_entries_fts_config",
	"subagent_entries_fts_data",
	"subagent_entries_fts_docsize",
	"subagent_entries_fts_idx",
	"subagent_entries_ai",
	"subagent_entries_ad",
]);

const SCHEMA_SQL = `
CREATE TABLE subagent_sessions (
  session_id TEXT PRIMARY KEY,
  relative_filename TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  inode INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  entry_count INTEGER NOT NULL
);

CREATE TABLE subagent_entries (
  rowid INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES subagent_sessions(session_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  parent_id TEXT,
  ordinal INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  role TEXT,
  text_content TEXT,
  raw_offset INTEGER NOT NULL,
  raw_length INTEGER NOT NULL,
  UNIQUE(session_id, entry_id),
  UNIQUE(session_id, ordinal)
);

CREATE VIRTUAL TABLE subagent_entries_fts USING fts5(
  text_content,
  content='subagent_entries',
  content_rowid='rowid'
);
CREATE TRIGGER subagent_entries_ai AFTER INSERT ON subagent_entries BEGIN
  INSERT INTO subagent_entries_fts(rowid, text_content) VALUES (new.rowid, new.text_content);
END;
CREATE TRIGGER subagent_entries_ad AFTER DELETE ON subagent_entries BEGIN
  INSERT INTO subagent_entries_fts(subagent_entries_fts, rowid, text_content)
    VALUES('delete', old.rowid, old.text_content);
END;
`;

export class SubagentHistoryStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentHistoryStoreError";
	}
}

export class SubagentHistoryFtsQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentHistoryFtsQueryError";
	}
}

export function getSubagentHistoryDbPath(agentDir = getAgentDir()): string {
	return join(agentDir, "cache", "kstack-subagent-history", "index.sqlite3");
}

function errorCode(error: BoundaryValue): string | undefined {
	if (!isObject(error) || error === null || !("code" in error)) return undefined;
	return isString(error.code) ? error.code : undefined;
}

function ensureDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new SubagentHistoryStoreError(`unsafe subagent history cache directory: ${path}`);
	}
	try {
		chmodSync(path, 0o700);
	} catch {
		// Best effort where POSIX modes are unavailable.
	}
}

function validateNoSymlink(path: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) {
			throw new SubagentHistoryStoreError(`unsafe symlink at subagent history cache path: ${path}`);
		}
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function prepareCacheFile(dbPath: string): void {
	const cacheDir = dirname(dbPath);
	const cacheRoot = dirname(cacheDir);
	const agentDir = dirname(cacheRoot);
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const agentStat = lstatSync(agentDir);
	if (!agentStat.isDirectory() || agentStat.isSymbolicLink()) {
		throw new SubagentHistoryStoreError(`unsafe Pi agent directory for subagent history cache: ${agentDir}`);
	}
	ensureDirectory(cacheRoot);
	ensureDirectory(cacheDir);
	if (dirname(realpathSync(cacheDir)) !== realpathSync(cacheRoot)) {
		throw new SubagentHistoryStoreError("subagent history cache directory escapes its cache root");
	}
	for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) validateNoSymlink(path);

	let fd: number;
	try {
		fd = openSync(dbPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		fd = openSync(dbPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	}
	try {
		const stat = lstatSync(dbPath);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new SubagentHistoryStoreError("subagent history cache database is not a regular file");
		}
	} finally {
		closeSync(fd);
	}
}

function decodeNumber(row: JsonObject, table: string, column: string): number {
	const value = row[column];
	if (!isNumber(value) || !Number.isFinite(value)) {
		throw new SubagentHistoryStoreError(`${table} returned invalid ${column}`);
	}
	return value;
}

function decodeString(row: JsonObject, table: string, column: string): string {
	const value = row[column];
	if (!isString(value)) throw new SubagentHistoryStoreError(`${table} returned invalid ${column}`);
	return value;
}

function decodeNullableString(row: JsonObject, table: string, column: string): string | null {
	const value = row[column];
	if (value !== null && !isString(value)) {
		throw new SubagentHistoryStoreError(`${table} returned invalid ${column}`);
	}
	return value;
}

function rowObject(value: BoundaryValue, table: string): JsonObject {
	const row = asRecord(value);
	if (!row) throw new SubagentHistoryStoreError(`${table} returned a non-object row`);
	return row;
}

function schemaVersion(db: DatabaseSync): number {
	const value = rowObject(db.prepare("PRAGMA user_version").get(), "subagent history cache");
	return decodeNumber(value, "subagent history cache", "user_version");
}

function validateSchema(db: DatabaseSync): void {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'subagent_%'").all();
	const actual = new Set(rows.map((value) => decodeString(rowObject(value, "sqlite_master"), "sqlite_master", "name")));
	for (const expected of EXPECTED_SCHEMA_OBJECTS) {
		if (!actual.has(expected)) {
			throw new SubagentHistoryStoreError(`subagent history cache schema is corrupt (missing ${expected})`);
		}
	}
}

function initializeSchema(db: DatabaseSync): void {
	const version = schemaVersion(db);
	if (version === SCHEMA_VERSION) {
		validateSchema(db);
		return;
	}
	if (version !== 0) {
		throw new SubagentHistoryStoreError(
			`unsupported subagent history cache schema version ${version} (expected ${SCHEMA_VERSION})`,
		);
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		if (schemaVersion(db) !== 0) {
			db.exec("ROLLBACK");
			initializeSchema(db);
			return;
		}
		db.exec(SCHEMA_SQL);
		db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		db.exec("COMMIT");
		validateSchema(db);
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		if (error instanceof SubagentHistoryStoreError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SubagentHistoryStoreError(`could not initialize subagent history cache: ${message.slice(0, 300)}`);
	}
}

export function openSubagentHistoryStore(dbPath: string): DatabaseSync {
	if (dbPath !== ":memory:") prepareCacheFile(dbPath);
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
		db.exec("PRAGMA foreign_keys=ON");
		if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
		initializeSchema(db);
		if (dbPath !== ":memory:") {
			validateNoSymlink(dbPath);
			const stat = lstatSync(dbPath);
			if (!stat.isFile()) throw new SubagentHistoryStoreError("subagent history cache database changed identity");
			for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
				try {
					chmodSync(path, 0o600);
				} catch {
					// Best effort: sidecars may not exist yet, and POSIX modes may be unavailable.
				}
			}
		}
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export interface IndexedSubagentSessionInput {
	/** Canonical lowercase UUID from the validated filename; the store never keys on the raw header id. */
	sessionId: string;
	header: ParsedSessionHeader;
	entries: ParsedEntry[];
	relativeFilename: string;
	signature: SubagentFileSignature;
	name: string | null;
}

export interface IndexedSubagentSession {
	sessionId: string;
	relativeFilename: string;
	signature: SubagentFileSignature;
	cwd: string;
	name: string | null;
	createdAt: string;
	entryCount: number;
}

function decodeSession(value: BoundaryValue): IndexedSubagentSession {
	const table = "subagent_sessions";
	const row = rowObject(value, table);
	return {
		sessionId: decodeString(row, table, "session_id"),
		relativeFilename: decodeString(row, table, "relative_filename"),
		signature: {
			size: decodeNumber(row, table, "file_size"),
			mtimeMs: decodeNumber(row, table, "mtime_ms"),
			inode: decodeNumber(row, table, "inode"),
		},
		cwd: decodeString(row, table, "cwd"),
		name: decodeNullableString(row, table, "name"),
		createdAt: decodeString(row, table, "created_at"),
		entryCount: decodeNumber(row, table, "entry_count"),
	};
}

const SESSION_COLUMNS = "session_id, relative_filename, file_size, mtime_ms, inode, cwd, name, created_at, entry_count";

export function listIndexedSubagentSessions(db: DatabaseSync): IndexedSubagentSession[] {
	return db.prepare(`SELECT ${SESSION_COLUMNS} FROM subagent_sessions`).all().map(decodeSession);
}

export function getIndexedSubagentSession(db: DatabaseSync, sessionId: string): IndexedSubagentSession | undefined {
	const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM subagent_sessions WHERE session_id = ?`).get(sessionId);
	return row === undefined ? undefined : decodeSession(row);
}

export function replaceIndexedSubagentSession(db: DatabaseSync, input: IndexedSubagentSessionInput): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare(
			`INSERT INTO subagent_sessions (
			   session_id, relative_filename, file_size, mtime_ms, inode,
			   cwd, name, created_at, entry_count
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(session_id) DO UPDATE SET
			   relative_filename=excluded.relative_filename,
			   file_size=excluded.file_size, mtime_ms=excluded.mtime_ms, inode=excluded.inode,
			   cwd=excluded.cwd, name=excluded.name, created_at=excluded.created_at,
			   entry_count=excluded.entry_count`,
		).run(
			input.sessionId,
			input.relativeFilename,
			input.signature.size,
			input.signature.mtimeMs,
			input.signature.inode,
			input.header.cwd,
			input.name,
			input.header.timestamp,
			input.entries.length,
		);
		db.prepare("DELETE FROM subagent_entries WHERE session_id = ?").run(input.sessionId);
		const insert = db.prepare(
			`INSERT INTO subagent_entries (
			   session_id, entry_id, parent_id, ordinal, timestamp,
			   entry_type, role, text_content, raw_offset, raw_length
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const entry of input.entries) {
			insert.run(
				input.sessionId,
				entry.entryId,
				entry.parentId,
				entry.ordinal,
				entry.timestamp,
				entry.entryType,
				entry.role ?? null,
				entry.textContent ?? null,
				entry.rawOffset,
				entry.rawLength,
			);
		}
		db.exec("COMMIT");
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

export function deleteIndexedSubagentSessions(db: DatabaseSync, sessionIds: string[]): void {
	if (sessionIds.length === 0) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		const deleteEntries = db.prepare("DELETE FROM subagent_entries WHERE session_id = ?");
		const deleteSession = db.prepare("DELETE FROM subagent_sessions WHERE session_id = ?");
		for (const sessionId of new Set(sessionIds)) {
			deleteEntries.run(sessionId);
			deleteSession.run(sessionId);
		}
		db.exec("COMMIT");
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

export interface SubagentHistorySearchHit {
	sessionId: string;
	relativeFilename: string;
	entryId: string;
	entryType: string;
	ordinal: number;
	role: string | null;
	timestamp: string;
	cwd: string;
	sessionName: string | null;
	snippet: string;
}

function decodeSearchHit(value: BoundaryValue): SubagentHistorySearchHit {
	const table = "subagent history search";
	const row = rowObject(value, table);
	return {
		sessionId: decodeString(row, table, "session_id"),
		relativeFilename: decodeString(row, table, "relative_filename"),
		entryId: decodeString(row, table, "entry_id"),
		entryType: decodeString(row, table, "entry_type"),
		ordinal: decodeNumber(row, table, "ordinal"),
		role: decodeNullableString(row, table, "role"),
		timestamp: decodeString(row, table, "timestamp"),
		cwd: decodeString(row, table, "cwd"),
		sessionName: decodeNullableString(row, table, "session_name"),
		snippet: decodeString(row, table, "snippet"),
	};
}

export function searchIndexedSubagentHistory(
	db: DatabaseSync,
	options: { query: string; cwd?: string; role?: string; sessionId?: string; limit?: number; offset?: number },
): SubagentHistorySearchHit[] {
	const statement = db.prepare(
		`SELECT e.session_id, s.relative_filename, e.entry_id, e.entry_type,
		        e.ordinal, e.role, e.timestamp, s.cwd, s.name AS session_name,
		        substr(snippet(subagent_entries_fts, 0, '[', ']', '…', 32), 1, 2048) AS snippet
		   FROM subagent_entries_fts
		   JOIN subagent_entries e ON e.rowid = subagent_entries_fts.rowid
		   JOIN subagent_sessions s ON s.session_id = e.session_id
		  WHERE subagent_entries_fts MATCH ?
		    AND (? IS NULL OR s.cwd = ?)
		    AND (? IS NULL OR e.role = ?)
		    AND (? IS NULL OR e.session_id = ?)
		  ORDER BY rank, e.timestamp DESC, e.rowid
		  LIMIT ? OFFSET ?`,
	);
	try {
		return statement
			.all(
				options.query,
				options.cwd ?? null,
				options.cwd ?? null,
				options.role ?? null,
				options.role ?? null,
				options.sessionId ?? null,
				options.sessionId ?? null,
				options.limit ?? 20,
				options.offset ?? 0,
			)
			.map(decodeSearchHit);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/fts5:|unterminated string|no such column:/i.test(message)) {
			throw new SubagentHistoryFtsQueryError(
				`invalid FTS5 query ${JSON.stringify(options.query).slice(0, 300)}: ${message.slice(0, 300)}. ` +
					'Use plain words, "quoted phrases", AND/OR/NOT, or prefix* terms.',
			);
		}
		throw error;
	}
}

interface IndexedSubagentEntry {
	entryId: string;
	parentId: string | null;
	ordinal: number;
	timestamp: string;
	entryType: string;
	role: string | null;
	textContent: string | null;
	rawOffset: number;
	rawLength: number;
}

function decodeEntry(value: BoundaryValue): IndexedSubagentEntry {
	const table = "subagent_entries";
	const row = rowObject(value, table);
	return {
		entryId: decodeString(row, table, "entry_id"),
		parentId: decodeNullableString(row, table, "parent_id"),
		ordinal: decodeNumber(row, table, "ordinal"),
		timestamp: decodeString(row, table, "timestamp"),
		entryType: decodeString(row, table, "entry_type"),
		role: decodeNullableString(row, table, "role"),
		textContent: decodeNullableString(row, table, "text_content"),
		rawOffset: decodeNumber(row, table, "raw_offset"),
		rawLength: decodeNumber(row, table, "raw_length"),
	};
}

export function readIndexedSubagentEntries(
	db: DatabaseSync,
	sessionId: string,
	offset: number,
	limit: number,
): IndexedSubagentEntry[] {
	return db
		.prepare(
			`SELECT entry_id, parent_id, ordinal, timestamp, entry_type,
			        role, text_content, raw_offset, raw_length
			   FROM subagent_entries
			  WHERE session_id = ?
			  ORDER BY ordinal
			  LIMIT ? OFFSET ?`,
		)
		.all(sessionId, limit, offset)
		.map(decodeEntry);
}
