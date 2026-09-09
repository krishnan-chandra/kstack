/** Normalized history entry text, UTF-8 chunk selection, and continuation facts. */
import { splitUtf8Chunks } from "./tool-output.ts";

export interface HistoryEntry {
	ordinal: number;
	entryType: string;
	role?: string | null;
	timestamp: string;
	entryId: string;
	parentId: string | null;
	textContent?: string | null;
}

export function formatHistoryEntry(entry: HistoryEntry): string {
	const role = entry.role ? `/${entry.role}` : "";
	const header = `#${entry.ordinal} [${entry.entryType}${role}] ${entry.timestamp} (id ${entry.entryId}, parent ${entry.parentId ?? "none"})`;
	return entry.textContent ? `${header}\n${entry.textContent}` : header;
}

export function formatHistoryEntries(entries: readonly HistoryEntry[]): string {
	return entries.map(formatHistoryEntry).join("\n\n");
}

export function selectHistoryPage(input: {
	body: string;
	offset: number;
	pageEntries: number;
	totalEntries: number;
	chunk: number;
	maxBytes: number;
}) {
	const chunks = splitUtf8Chunks(input.body, input.maxBytes);
	if (input.chunk >= chunks.length) {
		return {
			ok: false as const,
			reason: `Chunk ${input.chunk} is out of range; this page has ${chunks.length} chunk(s).`,
		};
	}
	let next: { offset: number; chunk: number } | null = null;
	if (input.chunk + 1 < chunks.length) {
		next = { offset: input.offset, chunk: input.chunk + 1 };
	} else if (input.offset + input.pageEntries < input.totalEntries) {
		next = { offset: input.offset + input.pageEntries, chunk: 0 };
	}
	return {
		ok: true as const,
		body: chunks[input.chunk],
		chunk: input.chunk,
		chunks: chunks.length,
		next,
		range:
			input.pageEntries === 0
				? "no entries"
				: `entries ${input.offset + 1}–${input.offset + input.pageEntries} of ${input.totalEntries}`,
	};
}

export function historyPageNextLabel(
	next: { offset: number; chunk: number } | null,
	options: { end: string; fromStart?: boolean },
): string {
	if (next === null) return options.end;
	if (next.chunk !== 0) return `continue with the same offset/limit and chunk ${next.chunk}`;
	if (options.fromStart) return `continue with offset ${next.offset}, from=start, and chunk 0`;
	return `continue with offset ${next.offset} and chunk 0`;
}
