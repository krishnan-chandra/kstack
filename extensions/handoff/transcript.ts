/**
 * Load the previous session's transcript for handoff history tools. Active
 * sessions and archived artifacts at or below the transcript cap share one
 * parsed representation; larger archives use the bounded SQL fallback.
 */

import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getArchiveDbPath, getArchiveRoot, isPathInside, validateSessionId } from "../session-archive/archive-files.ts";
import { getSessionRow, openArchiveDbReadOnly } from "../session-archive/archive-store.ts";
import { type ParsedEntry, parseSessionJsonlBytes } from "../session-archive/session-jsonl.ts";
import { getAgentDir } from "../shared/kstack-config.ts";
import { isRecord } from "../shared/narrow.ts";
import { type BoundaryValue, isString, type JsonObject } from "../shared/validation.ts";
import { collapseWhitespace } from "./text.ts";

type ArchiveSessionRow = NonNullable<ReturnType<typeof getSessionRow>>;

export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_LINE_BYTES = 64 * 1024;
const TARGET_KEYS = [
	"path",
	"file_path",
	"command",
	"pattern",
	"query",
	"url",
	"tool",
	"agent",
	"name",
	"session_id",
] as const;

/** The provenance fields the loader needs; `HandoffSource` satisfies this shape. */
interface TranscriptSource {
	sessionFile: string;
	sessionId: string;
}

export interface ToolCallSummary {
	id: string;
	name: string;
	/** First allowlisted string argument, whitespace-collapsed; never an edit or write payload. */
	target?: string;
	/** Size-only description of an `edit` or `write` payload. */
	note?: string;
}

export type TranscriptDetail =
	| { kind: "assistant"; toolCalls: ToolCallSummary[] }
	| { kind: "toolResult"; toolCallId: string; toolName: string; isError: boolean }
	| { kind: "custom"; customType: string }
	| { kind: "none" };

export interface TranscriptEntry extends ParsedEntry {
	detail: TranscriptDetail;
}

/** A parsed active session or archived artifact at or below the transcript cap. */
export interface SessionTranscript {
	kind: "transcript";
	sourceKind: "active" | "archived";
	sessionId: string;
	cwd: string;
	entries: TranscriptEntry[];
}

/** An archived artifact above the transcript cap; readers fall back to the archive database. */
type HandoffTranscript = SessionTranscript | { kind: "oversized-archive" };

export interface HandoffHistoryFs {
	statSync(path: string): Stats;
	readFileSync: typeof readFileSync;
}

const defaultFs: HandoffHistoryFs = { statSync, readFileSync };

interface TranscriptCacheEntry {
	canonical: string;
	size: number;
	mtimeMs: number;
	ino: number;
	sessionId: string;
	transcript: SessionTranscript;
}

let transcriptCache: TranscriptCacheEntry | undefined;

/** Test hook for isolating module-level cache behavior. */
export function clearHandoffParseCache(): void {
	transcriptCache = undefined;
}

function isMissing(error: BoundaryValue): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

export function toolCallsOf(entry: TranscriptEntry): ToolCallSummary[] {
	return entry.detail.kind === "assistant" ? entry.detail.toolCalls : [];
}

function summarizeTarget(name: string, args: JsonObject): Pick<ToolCallSummary, "target" | "note"> {
	const summary: Pick<ToolCallSummary, "target" | "note"> = {};
	for (const key of TARGET_KEYS) {
		const value = args[key];
		if (isString(value) && value.trim()) {
			summary.target = collapseWhitespace(value);
			break;
		}
	}
	if (name === "edit") {
		const edits = args.edits;
		const count = Array.isArray(edits) ? edits.length : 1;
		summary.note = `${count} edit${count === 1 ? "" : "s"}`;
	} else if (name === "write" && isString(args.content)) {
		summary.note = `${Buffer.byteLength(args.content)} bytes`;
	}
	return summary;
}

function messageToolCalls(message: JsonObject): ToolCallSummary[] {
	const content = message.content;
	if (!Array.isArray(content)) return [];
	const calls: ToolCallSummary[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "toolCall" || !isString(block.name)) continue;
		const id = isString(block.id) ? block.id : "";
		const args = isRecord(block.arguments) ? block.arguments : {};
		calls.push({ id, name: block.name, ...summarizeTarget(block.name, args) });
	}
	return calls;
}

/** Derive handoff details from the raw entry the canonical parser already decoded and validated. */
function detailOf(entry: ParsedEntry, raw: JsonObject): TranscriptDetail {
	if (entry.entryType === "custom_message") {
		return { kind: "custom", customType: isString(raw.customType) ? raw.customType : "custom" };
	}
	const message = raw.message;
	if (entry.entryType !== "message" || !isRecord(message)) return { kind: "none" };
	if (entry.role === "assistant") return { kind: "assistant", toolCalls: messageToolCalls(message) };
	if (entry.role !== "toolResult") return { kind: "none" };
	return {
		kind: "toolResult",
		toolCallId: isString(message.toolCallId) ? message.toolCallId : "",
		toolName: isString(message.toolName) ? message.toolName : "tool",
		isError: message.isError === true,
	};
}

function assertHeaderId(sessionId: string, headerId: string): void {
	if (headerId !== sessionId) {
		throw new Error(`Previous session ID mismatch: reference says ${sessionId}, file header says ${headerId}.`);
	}
}

function parseTranscript(bytes: Buffer, sessionId: string, sourceKind: "active" | "archived"): SessionTranscript {
	const entries: TranscriptEntry[] = [];
	const parsed = parseSessionJsonlBytes(bytes, (entry, raw) => {
		entries.push({ ...entry, detail: detailOf(entry, raw) });
	});
	assertHeaderId(sessionId, parsed.header.id);
	return { kind: "transcript", sourceKind, sessionId, cwd: parsed.header.cwd, entries };
}

/** Parse `canonical`, reusing the cached transcript while the file identity and session ID are unchanged. */
function readCached(
	canonical: string,
	stat: Stats,
	sessionId: string,
	sourceKind: "active" | "archived",
	fsImpl: HandoffHistoryFs,
): SessionTranscript {
	const cache = transcriptCache;
	if (
		cache?.canonical === canonical &&
		cache.size === stat.size &&
		cache.mtimeMs === stat.mtimeMs &&
		cache.ino === stat.ino &&
		cache.sessionId === sessionId
	) {
		return cache.transcript;
	}
	const transcript = parseTranscript(fsImpl.readFileSync(canonical), sessionId, sourceKind);
	transcriptCache = { canonical, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, sessionId, transcript };
	return transcript;
}

/** Canonical path of a regular, non-symlink `.jsonl` file inside `root`; a missing file throws with code ENOENT. */
function canonicalJsonlInside(path: string, root: string, label: string, rootName: string): string {
	const lst = lstatSync(path, { throwIfNoEntry: false });
	if (!lst) throw Object.assign(new Error(`${label} is missing: ${path}`), { code: "ENOENT" });
	if (lst.isSymbolicLink() || !lst.isFile()) throw new Error(`${label} is not a regular non-symlink file: ${path}`);
	const canonical = realpathSync(path);
	const canonicalRoot = existsSync(root) ? realpathSync(root) : resolve(root);
	if (!isPathInside(canonical, canonicalRoot)) throw new Error(`${label} is outside ${rootName}: ${canonical}`);
	if (!canonical.endsWith(".jsonl")) throw new Error(`${label} is not a JSONL file: ${canonical}`);
	return canonical;
}

/** Read the active JSONL, or return undefined when it no longer exists at its recorded path. */
export function readActiveTranscript(
	source: TranscriptSource,
	env: NodeJS.ProcessEnv,
	fsImpl: HandoffHistoryFs = defaultFs,
): SessionTranscript | undefined {
	validateSessionId(source.sessionId);
	try {
		const activeRoot = join(getAgentDir(env), "sessions");
		const canonical = canonicalJsonlInside(
			source.sessionFile,
			activeRoot,
			"Previous session",
			"Pi's active session directory",
		);
		// The file may move between validation, the cache check, and reading.
		const stat = fsImpl.statSync(canonical);
		if (stat.size > MAX_TRANSCRIPT_BYTES) {
			throw new Error(
				`Previous session is ${stat.size} bytes, over the ${MAX_TRANSCRIPT_BYTES}-byte active-reader limit; use /handoff --archive to hand off an oversized session.`,
			);
		}
		return readCached(canonical, stat, source.sessionId, "active", fsImpl);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** Validate an oversized artifact's header with a bounded first-line read instead of parsing the file. */
function assertArchivedHeader(path: string, sessionId: string): void {
	const buffer = Buffer.alloc(MAX_HEADER_LINE_BYTES);
	const fd = openSync(path, "r");
	let length: number;
	try {
		length = readSync(fd, buffer, 0, buffer.length, 0);
	} finally {
		closeSync(fd);
	}
	const newline = buffer.subarray(0, length).indexOf(0x0a);
	if (newline === -1) {
		throw new Error(`Archived session header has no line break within ${MAX_HEADER_LINE_BYTES} bytes: ${path}`);
	}
	assertHeaderId(sessionId, parseSessionJsonlBytes(buffer.subarray(0, newline)).header.id);
}

/** Run `read` against the read-only archive database after proving the session is finalized there. */
export function withArchivedSessionDb<T>(
	sessionId: string,
	env: NodeJS.ProcessEnv,
	read: (db: DatabaseSync, row: ArchiveSessionRow) => T,
): T {
	const dbPath = getArchiveDbPath(getArchiveRoot(env));
	if (!existsSync(dbPath)) throw new Error(`Previous session ${sessionId} is not active or archived.`);
	const db = openArchiveDbReadOnly(dbPath);
	try {
		const row = getSessionRow(db, sessionId);
		if (row?.state !== "archived") {
			throw new Error(`Previous session ${sessionId} is not active or finalized in the archive.`);
		}
		return read(db, row);
	} finally {
		db.close();
	}
}

function readArchivedTranscript(
	source: TranscriptSource,
	env: NodeJS.ProcessEnv,
	fsImpl: HandoffHistoryFs,
): HandoffTranscript {
	const row = withArchivedSessionDb(source.sessionId, env, (_db, sessionRow) => sessionRow);
	if (row.archive_path === null) throw new Error(`Archived session ${source.sessionId} has no archive artifact path.`);
	const canonical = canonicalJsonlInside(
		row.archive_path,
		getArchiveRoot(env),
		"Archived session artifact",
		"the archive root",
	);
	const stat = fsImpl.statSync(canonical);
	if (stat.size !== row.file_size) {
		throw new Error(
			`Archived session artifact is ${stat.size} bytes but the archive catalog records ${row.file_size}; run /sessions to check archive integrity.`,
		);
	}
	if (stat.size > MAX_TRANSCRIPT_BYTES) {
		assertArchivedHeader(canonical, source.sessionId);
		return { kind: "oversized-archive" };
	}
	return readCached(canonical, stat, source.sessionId, "archived", fsImpl);
}

/** Load the active transcript, or fall back to the finalized archive artifact by exact session ID. */
export function loadHandoffTranscript(
	source: TranscriptSource,
	env: NodeJS.ProcessEnv,
	fsImpl: HandoffHistoryFs = defaultFs,
): HandoffTranscript {
	return readActiveTranscript(source, env, fsImpl) ?? readArchivedTranscript(source, env, fsImpl);
}
