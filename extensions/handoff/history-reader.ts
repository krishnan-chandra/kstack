import type { DatabaseSync } from "node:sqlite";
import { boundedInteger, countEntries, readEntries } from "../session-archive/archive-store.ts";
import {
	formatHistoryEntries,
	type HistoryEntry,
	historyPageNextLabel,
	selectHistoryPage,
} from "../session-archive/history-page.ts";
import { MAX_TEXT_CONTENT_CHARS } from "../session-archive/session-jsonl.ts";
import { isString, type JsonValue } from "../shared/validation.ts";
import { renderOutline } from "./outline.ts";
import { clipUtf8, clipUtf8Start, collapseWhitespace } from "./text.ts";
import {
	clearHandoffParseCache,
	type HandoffHistoryFs,
	loadHandoffTranscript,
	MAX_TRANSCRIPT_BYTES,
	readActiveTranscript,
	type SessionTranscript,
	type ToolCallSummary,
	toolCallsOf,
	withArchivedSessionDb,
} from "./transcript.ts";

const MAX_PREFLIGHT_REASON_BYTES = 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const BODY_CHUNK_BYTES = MAX_OUTPUT_BYTES - 8192;
const MAX_OFFSET = 2_147_483_647;
const TOOL_OUTPUT_CLIP_BYTES = 800;
const TOOL_CALL_TARGET_BYTES = 240;
const TOOL_OUTPUT_ROLES = new Set(["toolResult", "bashExecution"]);

export interface HandoffSource {
	version: 1;
	sessionFile: string;
	sessionId: string;
	cwd: string;
}

export type HandoffHistoryPreflight = { kind: "ready" } | { kind: "rejected"; reason: string };

/** JSON object persisted on a handoff `custom_message`; fields are untrusted until decoded. */
interface HandoffSourceJson {
	version?: JsonValue;
	sessionFile?: JsonValue;
	sessionId?: JsonValue;
	cwd?: JsonValue;
}

/** Host fields `findHandoffSource` reads; `details` is JSON, not a domain value. */
export interface HandoffBranchEntry {
	type: string;
	customType?: string;
	details?: HandoffSourceJson;
}

interface ReadHandoffHistoryOptions {
	view?: "outline" | "entries";
	before?: number;
	full?: boolean;
	offset?: number;
	limit?: number;
	chunk?: number;
	from?: "start" | "tail";
}

function decodeHandoffSource(value: HandoffSourceJson | undefined): HandoffSource | undefined {
	if (value === undefined) return undefined;
	if (value.version !== 1 || !isString(value.sessionFile) || !isString(value.sessionId) || !isString(value.cwd)) {
		return undefined;
	}
	return {
		version: 1,
		sessionFile: value.sessionFile,
		sessionId: value.sessionId,
		cwd: value.cwd,
	};
}

/** Find the newest handoff provenance entry on the active branch. */
export function findHandoffSource(entries: readonly HandoffBranchEntry[]): HandoffSource | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom_message" || entry.customType !== "handoff") continue;
		const source = decodeHandoffSource(entry.details);
		if (source) return source;
	}
	return undefined;
}

function boundPreflightReason(reason: string): string {
	const normalized = collapseWhitespace(reason) || "Active session history is unreadable.";
	return clipUtf8(normalized, MAX_PREFLIGHT_REASON_BYTES, "...");
}

/** Validate only the current active file; unlike history reads, never fall back to an archive. */
export function preflightHandoffHistory(
	source: HandoffSource,
	env: NodeJS.ProcessEnv = process.env,
	fsImpl?: HandoffHistoryFs,
): HandoffHistoryPreflight {
	clearHandoffParseCache();
	try {
		if (!readActiveTranscript(source, env, fsImpl)) {
			return { kind: "rejected", reason: "The source session no longer exists at its recorded active path." };
		}
		return { kind: "ready" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Active session history is unreadable.";
		return { kind: "rejected", reason: boundPreflightReason(reason) };
	}
}

/** Prepare one entry's text for the entries view: clip tool output unless `full`, and list tool calls. */
function entryText(
	entry: { ordinal: number; role?: string | null; textContent?: string | null },
	calls: readonly ToolCallSummary[],
	full: boolean,
): string | undefined {
	const parts: string[] = [];
	const text = entry.textContent ?? "";
	const capped = text.length >= MAX_TEXT_CONTENT_CHARS;
	const bytes = Buffer.byteLength(text);
	if (!full && entry.role && TOOL_OUTPUT_ROLES.has(entry.role) && bytes > TOOL_OUTPUT_CLIP_BYTES) {
		const clipped = clipUtf8(text, TOOL_OUTPUT_CLIP_BYTES, "");
		parts.push(
			`${clipped}\n[+${bytes - Buffer.byteLength(clipped)} bytes clipped; read_handoff_history({ view: "entries", offset: ${entry.ordinal}, limit: 1, full: true })]`,
		);
	} else if (text) {
		parts.push(capped ? `${text}\n[normalized text capped at 200,000 characters by the session parser]` : text);
	}
	for (const call of calls) {
		const target = call.target ? ` ${clipUtf8(call.target, TOOL_CALL_TARGET_BYTES)}` : "";
		const note = call.note ? ` (${call.note})` : "";
		parts.push(`→ ${call.name}${target}${note}`);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function pageParams(options: ReadHandoffHistoryOptions, total: number) {
	const limit = boundedInteger(options.limit, 50, 1, 200);
	const chunk = boundedInteger(options.chunk, 0, 0, 1_000_000);
	const offset =
		options.offset === undefined && options.from !== "start"
			? Math.max(0, total - limit)
			: boundedInteger(options.offset, 0, 0, MAX_OFFSET);
	return { limit, chunk, offset };
}

function pageOutput(input: {
	sessionId: string;
	sourceKind: "active" | "archived";
	cwd: string;
	total: number;
	views: readonly HistoryEntry[];
	offset: number;
	limit: number;
	chunk: number;
}): string {
	const page = selectHistoryPage({
		body: formatHistoryEntries(input.views),
		offset: input.offset,
		pageEntries: input.views.length,
		totalEntries: input.total,
		chunk: input.chunk,
		maxBytes: BODY_CHUNK_BYTES,
	});
	if (!page.ok) throw new Error(page.reason);
	const next = historyPageNextLabel(page.next, { end: "end of session", fromStart: true });
	const keepView = page.next ? ' (keep view: "entries")' : "";
	const earlier =
		input.offset > 0
			? ` Earlier entries are available; use view "entries", offset ${Math.max(0, input.offset - input.limit)}, from=start, and chunk 0.`
			: "";
	return (
		`Previous session ${input.sessionId} — ${clipUtf8Start(input.cwd, 512)} — source: ${input.sourceKind} — view: entries\n` +
		`${page.range} — chunk ${page.chunk + 1} of ${page.chunks} — ${next}${keepView}.${earlier}\n\n${page.body}`
	);
}

function transcriptEntries(transcript: SessionTranscript, options: ReadHandoffHistoryOptions): string {
	const total = transcript.entries.length;
	const { limit, chunk, offset } = pageParams(options, total);
	const full = options.full === true;
	const views = transcript.entries.slice(offset, offset + limit).map((entry) => ({
		...entry,
		textContent: entryText(entry, toolCallsOf(entry), full),
	}));
	return pageOutput({
		sessionId: transcript.sessionId,
		sourceKind: transcript.sourceKind,
		cwd: transcript.cwd,
		total,
		views,
		offset,
		limit,
		chunk,
	});
}

function archivedEntries(db: DatabaseSync, sessionId: string, cwd: string, options: ReadHandoffHistoryOptions): string {
	const total = countEntries(db, sessionId);
	const { limit, chunk, offset } = pageParams(options, total);
	const full = options.full === true;
	const views = readEntries(db, sessionId, offset, limit).map((row) => {
		const entry = {
			ordinal: row.ordinal,
			entryType: row.entry_type,
			role: row.role,
			timestamp: row.timestamp,
			entryId: row.entry_id,
			parentId: row.parent_id,
			textContent: row.text_content,
		};
		return { ...entry, textContent: entryText(entry, [], full) };
	});
	return pageOutput({ sessionId, sourceKind: "archived", cwd, total, views, offset, limit, chunk });
}

/**
 * Read the linked previous session: an outline of the whole session by default,
 * or paged entries with clipped tool output. Prefers the active JSONL and falls
 * back to the finalized archive by exact session ID.
 */
export function readHandoffHistory(
	source: HandoffSource,
	options: ReadHandoffHistoryOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): string {
	const transcript = loadHandoffTranscript(source, env);
	const view = options.view ?? "outline";
	if (transcript.kind === "oversized-archive") {
		const entries = withArchivedSessionDb(source.sessionId, env, (db, row) =>
			archivedEntries(db, source.sessionId, row.cwd, options),
		);
		if (view === "entries") return entries;
		const limit = `${MAX_TRANSCRIPT_BYTES / (1024 * 1024)} MiB`;
		return `Outline unavailable: archived session exceeds the ${limit} transcript limit; showing the bounded entries view.\n${entries}`;
	}
	if (view === "entries") return transcriptEntries(transcript, options);
	const before = options.before === undefined ? undefined : boundedInteger(options.before, 0, 0, MAX_OFFSET);
	return renderOutline(transcript, { before });
}
