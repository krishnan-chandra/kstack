/**
 * Snippet search within the linked previous session. Transcript-backed sources
 * use case-insensitive substring AND matching over entry text and tool-call
 * targets; oversized archives use the archive's FTS5 index.
 */

import { boundedInteger, searchArchive } from "../session-archive/archive-store.ts";
import type { HandoffSource } from "./history-reader.ts";
import { clipUtf8, collapseWhitespace, type Utf8Window, utf8Window } from "./text.ts";
import {
	loadHandoffTranscript,
	type SessionTranscript,
	type TranscriptEntry,
	toolCallsOf,
	withArchivedSessionDb,
} from "./transcript.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_HIT_BYTES = 1024;
const MAX_SNIPPETS = 3;
const TEXT_SNIPPET_BYTES = 260;
const TARGET_SNIPPET_BYTES = 160;
const MIN_SNIPPET_BYTES = 40;
const MAX_CALL_LINES = 3;
const EXPAND_FOOTER =
	'Expand a match with read_handoff_history({ view: "entries", offset: <#>, limit: 1 }); add full: true for unclipped tool output.';

interface SearchHandoffHistoryOptions {
	query: string;
	role?: string;
	limit?: number;
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

function callText(call: { name: string; target?: string }): string {
	return call.target ? `${call.name} ${call.target}` : call.name;
}

function matches(entry: TranscriptEntry, terms: readonly string[]): boolean {
	const haystack = [entry.textContent ?? "", ...toolCallsOf(entry).map(callText)].join("\n").toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

function entryHeader(entry: {
	ordinal: number;
	entryType: string;
	role?: string | null;
	timestamp: string;
	entryId: string;
}): string {
	const role = entry.role ? `/${entry.role}` : "";
	return `#${entry.ordinal} [${entry.entryType}${role}] ${entry.timestamp} (id ${clipUtf8(entry.entryId, 64)})`;
}

/**
 * Up to `max` whitespace-collapsed snippets of at most `maxBytes` each, centred
 * on term occurrences: the first occurrence of each term, then further
 * occurrences of the first term, in text order.
 */
function snippets(text: string, terms: readonly string[], max: number, maxBytes: number): string[] {
	const collapsed = collapseWhitespace(text);
	if (!collapsed || max <= 0) return [];
	const lower = collapsed.toLowerCase();
	// Lowercasing changes the length of a few characters, so indices would not map back; show the head.
	if (lower.length !== collapsed.length) return [clipUtf8(collapsed, maxBytes)];
	const windows: Utf8Window[] = [];
	const add = (index: number, length: number) => {
		if (windows.length >= max || windows.some((window) => index >= window.from && index < window.to)) return;
		windows.push(utf8Window(collapsed, index, index + length, maxBytes));
	};
	for (const term of terms) {
		const index = lower.indexOf(term);
		if (index >= 0) add(index, term.length);
	}
	const [lead] = terms;
	if (lead !== undefined) {
		for (let index = lower.indexOf(lead); index >= 0 && windows.length < max; ) {
			add(index, lead.length);
			index = lower.indexOf(lead, index + lead.length);
		}
	}
	if (windows.length === 0) return [clipUtf8(collapsed, maxBytes)];
	return windows.sort((left, right) => left.from - right.from).map((window) => window.text);
}

function renderHit(entry: TranscriptEntry, terms: readonly string[]): string {
	const lines = [entryHeader(entry)];
	const matchingCalls = toolCallsOf(entry).filter((call) => {
		const text = callText(call).toLowerCase();
		return terms.some((term) => text.includes(term));
	});
	for (const call of matchingCalls.slice(0, MAX_CALL_LINES)) {
		const [target] = call.target ? snippets(call.target, terms, 1, TARGET_SNIPPET_BYTES) : [];
		lines.push(`  → ${clipUtf8(call.name, 40)}${target ? ` ${target}` : ""}`);
	}
	if (matchingCalls.length > MAX_CALL_LINES) {
		lines.push(`  → +${matchingCalls.length - MAX_CALL_LINES} more matching calls`);
	}
	// Split what is left of the hit budget between the text snippets so none is cut off.
	const remaining = MAX_HIT_BYTES - Buffer.byteLength(lines.join("\n")) - MAX_SNIPPETS * 3;
	const snippetBytes = Math.min(TEXT_SNIPPET_BYTES, Math.floor(remaining / MAX_SNIPPETS));
	if (snippetBytes >= MIN_SNIPPET_BYTES) {
		for (const snippet of snippets(entry.textContent ?? "", terms, MAX_SNIPPETS, snippetBytes)) {
			lines.push(`  ${snippet}`);
		}
	}
	return clipUtf8(lines.join("\n"), MAX_HIT_BYTES);
}

function searchTranscript(
	transcript: SessionTranscript,
	terms: readonly string[],
	role: string | undefined,
	limit: number,
): string {
	const normalized = terms.map((term) => term.toLowerCase());
	const hits = transcript.entries.filter((entry) => (!role || entry.role === role) && matches(entry, normalized));
	const label = `${transcript.sourceKind} previous session ${transcript.sessionId}`;
	if (hits.length === 0) return `No matches in ${label}.`;
	const shown = hits.slice(-limit);
	return [
		`Matches in ${label}: ${hits.length} total; showing the newest ${shown.length} in session order.`,
		EXPAND_FOOTER,
		"",
		shown.map((entry) => renderHit(entry, normalized)).join("\n\n"),
	].join("\n");
}

function searchOversizedArchive(
	sessionId: string,
	terms: string[],
	role: string | undefined,
	limit: number,
	env: NodeJS.ProcessEnv,
): string {
	const hits = withArchivedSessionDb(sessionId, env, (db) =>
		searchArchive(db, { query: archiveFtsQuery(terms), role, sessionId, limit }),
	);
	if (hits.length === 0) return `No matches in oversized archived previous session ${sessionId}.`;
	const rendered = hits.map((hit) => {
		const header = entryHeader({
			ordinal: hit.ordinal,
			entryType: hit.entry_type,
			role: hit.role,
			timestamp: hit.timestamp,
			entryId: hit.entry_id,
		});
		return clipUtf8(`${header}\n  ${collapseWhitespace(hit.snippet)}`, MAX_HIT_BYTES);
	});
	return [
		`Matches in archived previous session ${sessionId}: ${hits.length} shown.`,
		'Oversized archive: FTS token matching, ranked; expand with view: "entries", offset: <#>.',
		"",
		rendered.join("\n\n"),
	].join("\n");
}

/** Search the referenced previous session and return bounded snippets with entry ordinals. */
export function searchHandoffHistory(
	source: HandoffSource,
	options: SearchHandoffHistoryOptions,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const query = options.query.trim();
	if (!query) throw new Error("query must not be empty");
	const limit = boundedInteger(options.limit, 20, 1, 100);
	const terms = searchTerms(query);
	if (terms.length === 0) throw new Error("query must contain at least one word or quoted phrase");
	const transcript = loadHandoffTranscript(source, env);
	const output =
		transcript.kind === "transcript"
			? searchTranscript(transcript, terms, options.role, limit)
			: searchOversizedArchive(source.sessionId, terms, options.role, limit, env);
	const head = clipUtf8(output, MAX_OUTPUT_BYTES - 512, "");
	return head === output ? output : `${head}\n\n[Output truncated; refine the query or lower the limit.]`;
}
