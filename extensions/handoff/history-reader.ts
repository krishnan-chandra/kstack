import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getArchiveDbPath, getArchiveRoot, isPathInside, validateSessionId } from "../session-archive/archive-files.ts";
import {
	countEntries,
	getSessionRow,
	openArchiveDbReadOnly,
	readEntries,
	searchArchive,
} from "../session-archive/archive-store.ts";
import { type ParsedEntry, parseSessionJsonlBytes } from "../session-archive/session-jsonl.ts";
import { splitUtf8Chunks } from "../session-archive/tool-output.ts";
import { getAgentDir } from "../shared/kstack-config.ts";

const MAX_ACTIVE_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const BODY_CHUNK_BYTES = MAX_OUTPUT_BYTES - 8192;
const DEFAULT_READ_LIMIT = 20;

export interface HandoffSource {
	version: 1;
	sessionFile: string;
	sessionId: string;
	cwd: string;
}

interface HandoffEntryLike {
	type?: unknown;
	customType?: unknown;
	content?: unknown;
	details?: unknown;
}

interface ReadHandoffHistoryOptions {
	offset?: number;
	limit?: number;
	chunk?: number;
	from?: "start" | "tail";
}

interface SearchHandoffHistoryOptions {
	query: string;
	role?: string;
	limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceFromDetails(details: unknown): HandoffSource | undefined {
	if (!isRecord(details)) return undefined;
	if (
		details.version !== 1 ||
		typeof details.sessionFile !== "string" ||
		typeof details.sessionId !== "string" ||
		typeof details.cwd !== "string"
	) {
		return undefined;
	}
	return {
		version: 1,
		sessionFile: details.sessionFile,
		sessionId: details.sessionId,
		cwd: details.cwd,
	};
}

/** Backward-compatible fallback for handoff entries created before structured details. */
function sourceFromContent(content: unknown): HandoffSource | undefined {
	if (typeof content !== "string") return undefined;
	const file = content.match(/^Previous session: (.+)$/m)?.[1];
	const metadata = content.match(/^Session ID: (\S+) {2}CWD: (.+)$/m);
	if (!file || !metadata || file.startsWith("(")) return undefined;
	return { version: 1, sessionFile: file, sessionId: metadata[1], cwd: metadata[2] };
}

/** Find the newest handoff provenance entry on the active branch. */
export function findHandoffSource(entries: readonly HandoffEntryLike[]): HandoffSource | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom_message" || entry.customType !== "handoff") continue;
		const source = sourceFromDetails(entry.details) ?? sourceFromContent(entry.content);
		if (source) return source;
	}
	return undefined;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

function assertSafeActiveSessionPath(source: HandoffSource, env: NodeJS.ProcessEnv): string {
	validateSessionId(source.sessionId);
	const activeRoot = join(getAgentDir(env), "sessions");
	const lst = lstatSync(source.sessionFile, { throwIfNoEntry: false });
	if (!lst) throw Object.assign(new Error("active session file disappeared"), { code: "ENOENT" });
	if (lst.isSymbolicLink() || !lst.isFile()) {
		throw new Error(`Previous session path is not a regular non-symlink file: ${source.sessionFile}`);
	}
	const canonical = realpathSync(source.sessionFile);
	const canonicalRoot = existsSync(activeRoot) ? realpathSync(activeRoot) : resolve(activeRoot);
	if (!isPathInside(canonical, canonicalRoot)) {
		throw new Error(`Previous session is outside Pi's active session directory: ${canonical}`);
	}
	if (!canonical.endsWith(".jsonl")) throw new Error(`Previous session is not a JSONL file: ${canonical}`);
	const size = statSync(canonical).size;
	if (size > MAX_ACTIVE_SESSION_BYTES) {
		throw new Error(
			`Previous session is ${size} bytes, over the ${MAX_ACTIVE_SESSION_BYTES}-byte active-reader limit; archive it and retry.`,
		);
	}
	return canonical;
}

interface ActiveSession {
	source: "active";
	cwd: string;
	entries: ParsedEntry[];
}

interface ParsedCacheEntry {
	canonical: string;
	size: number;
	mtimeMs: number;
	ino: number;
	sessionId: string;
	parsed: ActiveSession;
}

export interface HandoffHistoryFs {
	statSync: typeof statSync;
	readFileSync: typeof readFileSync;
}

const defaultFs: HandoffHistoryFs = { statSync, readFileSync };
let parseCache: ParsedCacheEntry | undefined;

/** Test hook for isolating module-level cache behavior. */
export function clearHandoffParseCache(): void {
	parseCache = undefined;
}

function readActiveSession(
	source: HandoffSource,
	env: NodeJS.ProcessEnv,
	fsImpl: HandoffHistoryFs,
): ActiveSession | undefined {
	let canonical: string;
	try {
		canonical = assertSafeActiveSessionPath(source, env);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let stat;
	try {
		stat = fsImpl.statSync(canonical);
	} catch (error) {
		// The file may have moved between validation and the cache check.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (
		parseCache?.canonical === canonical &&
		parseCache.size === stat.size &&
		parseCache.mtimeMs === stat.mtimeMs &&
		parseCache.ino === stat.ino &&
		parseCache.sessionId === source.sessionId
	) {
		return parseCache.parsed;
	}

	let parsed;
	try {
		parsed = parseSessionJsonlBytes(fsImpl.readFileSync(canonical));
	} catch (error) {
		// The file may have moved between validation and reading.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (parsed.header.id !== source.sessionId) {
		throw new Error(
			`Previous session ID mismatch: reference says ${source.sessionId}, file header says ${parsed.header.id}.`,
		);
	}
	const active: ActiveSession = { source: "active", cwd: parsed.header.cwd, entries: parsed.entries };
	parseCache = {
		canonical,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ino: stat.ino,
		sessionId: source.sessionId,
		parsed: active,
	};
	return active;
}

function formatEntry(entry: {
	ordinal: number;
	entryType: string;
	role?: string | null;
	timestamp: string;
	entryId: string;
	parentId: string | null;
	textContent?: string | null;
}): string {
	return [
		`#${entry.ordinal} [${entry.entryType}${entry.role ? `/${entry.role}` : ""}] ${entry.timestamp} (id ${entry.entryId}, parent ${entry.parentId ?? "none"})`,
		entry.textContent ?? "",
	]
		.filter(Boolean)
		.join("\n");
}

function parsedEntryView(entry: ParsedEntry) {
	return {
		ordinal: entry.ordinal,
		entryType: entry.entryType,
		role: entry.role,
		timestamp: entry.timestamp,
		entryId: entry.entryId,
		parentId: entry.parentId,
		textContent: entry.textContent,
	};
}

function archiveEntryView(entry: ReturnType<typeof readEntries>[number]) {
	return {
		ordinal: entry.ordinal,
		entryType: entry.entry_type,
		role: entry.role,
		timestamp: entry.timestamp,
		entryId: entry.entry_id,
		parentId: entry.parent_id,
		textContent: entry.text_content,
	};
}

function pageOutput(
	source: HandoffSource,
	sourceKind: "active" | "archived",
	cwd: string,
	total: number,
	views: Array<ReturnType<typeof parsedEntryView> | ReturnType<typeof archiveEntryView>>,
	offset: number,
	limit: number,
	chunkIndex: number,
): string {
	const body = views.map(formatEntry).join("\n\n");
	const chunks = splitUtf8Chunks(body, BODY_CHUNK_BYTES);
	if (chunkIndex >= chunks.length) {
		throw new Error(`Chunk ${chunkIndex} is out of range; this page has ${chunks.length} chunk(s).`);
	}
	const range = views.length === 0 ? "no entries" : `entries ${offset + 1}–${offset + views.length} of ${total}`;
	const next =
		chunkIndex + 1 < chunks.length
			? `continue with the same offset/limit and chunk ${chunkIndex + 1}`
			: offset + views.length < total
				? `continue with offset ${offset + views.length}, from=start, and chunk 0`
				: "end of session";
	const earlier =
		offset > 0
			? ` Earlier entries are available; use offset ${Math.max(0, offset - limit)}, from=start, and chunk 0.`
			: "";
	return (
		`Previous session ${source.sessionId} — ${cwd} — source: ${sourceKind}\n` +
		`${range} — chunk ${chunkIndex + 1} of ${chunks.length} — ${next}.${earlier}\n\n${chunks[chunkIndex]}`
	);
}

/** Read normalized entries, preferring the active JSONL and falling back to the archive by exact ID. */
export function readHandoffHistory(
	source: HandoffSource,
	options: ReadHandoffHistoryOptions = {},
	env: NodeJS.ProcessEnv = process.env,
	fsImpl: HandoffHistoryFs = defaultFs,
): string {
	const limit = boundedInteger(options.limit, DEFAULT_READ_LIMIT, 1, 200);
	const chunk = boundedInteger(options.chunk, 0, 0, 1_000_000);
	const active = readActiveSession(source, env, fsImpl);
	if (active) {
		const total = active.entries.length;
		const offset =
			options.offset === undefined && options.from !== "start"
				? Math.max(0, total - limit)
				: boundedInteger(options.offset, 0, 0, 2_147_483_647);
		const views = active.entries.slice(offset, offset + limit).map(parsedEntryView);
		return pageOutput(source, "active", active.cwd, total, views, offset, limit, chunk);
	}

	const dbPath = getArchiveDbPath(getArchiveRoot(env));
	if (!existsSync(dbPath)) throw new Error(`Previous session ${source.sessionId} is not active or archived.`);
	const db = openArchiveDbReadOnly(dbPath);
	try {
		const session = getSessionRow(db, source.sessionId);
		if (session?.state !== "archived") {
			throw new Error(`Previous session ${source.sessionId} is not active or finalized in the archive.`);
		}
		const total = countEntries(db, source.sessionId);
		const offset =
			options.offset === undefined && options.from !== "start"
				? Math.max(0, total - limit)
				: boundedInteger(options.offset, 0, 0, 2_147_483_647);
		const views = readEntries(db, source.sessionId, offset, limit).map(archiveEntryView);
		return pageOutput(source, "archived", session.cwd, total, views, offset, limit, chunk);
	} finally {
		db.close();
	}
}

function searchTerms(query: string): string[] {
	return (query.match(/"[^"]+"|\S+/gu) ?? [])
		.map((term) => (term.startsWith('"') && term.endsWith('"') ? term.slice(1, -1) : term))
		.map((term) => term.trim())
		.filter(Boolean);
}

function archiveFtsQuery(terms: string[]): string {
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

/** Search normalized text in the referenced active session, or its archived FTS index. */
export function searchHandoffHistory(
	source: HandoffSource,
	options: SearchHandoffHistoryOptions,
	env: NodeJS.ProcessEnv = process.env,
	fsImpl: HandoffHistoryFs = defaultFs,
): string {
	const query = options.query.trim();
	if (!query) throw new Error("query must not be empty");
	const limit = boundedInteger(options.limit, 20, 1, 100);
	const terms = searchTerms(query);
	if (terms.length === 0) throw new Error("query must contain at least one word or quoted phrase");
	const active = readActiveSession(source, env, fsImpl);
	let output: string;
	if (active) {
		const hits = active.entries
			.filter((entry) => !options.role || entry.role === options.role)
			.filter((entry) => {
				const haystack = (entry.textContent ?? "").toLocaleLowerCase();
				return terms.every((term) => haystack.includes(term));
			})
			.slice(-limit)
			.map(parsedEntryView);
		output =
			hits.length === 0
				? `No matches in active previous session ${source.sessionId}.`
				: `Matches in active previous session ${source.sessionId}:\n\n${hits.map(formatEntry).join("\n\n")}`;
	} else {
		const dbPath = getArchiveDbPath(getArchiveRoot(env));
		if (!existsSync(dbPath)) throw new Error(`Previous session ${source.sessionId} is not active or archived.`);
		const db = openArchiveDbReadOnly(dbPath);
		try {
			const session = getSessionRow(db, source.sessionId);
			if (session?.state !== "archived") {
				throw new Error(`Previous session ${source.sessionId} is not active or finalized in the archive.`);
			}
			const hits = searchArchive(db, {
				query: archiveFtsQuery(terms),
				role: options.role,
				sessionId: source.sessionId,
				limit,
			});
			output =
				hits.length === 0
					? `No matches in archived previous session ${source.sessionId}.`
					: `Matches in archived previous session ${source.sessionId}:\n\n${hits
							.map(
								(hit) =>
									`#${hit.ordinal} [${hit.role ?? hit.entry_type}] ${hit.timestamp} (id ${hit.entry_id})\n${hit.snippet}`,
							)
							.join("\n\n")}`;
		} finally {
			db.close();
		}
	}

	const chunks = splitUtf8Chunks(output, MAX_OUTPUT_BYTES - 512);
	return chunks.length === 1 ? chunks[0] : `${chunks[0]}\n\n[Output truncated; refine the query or lower the limit.]`;
}
