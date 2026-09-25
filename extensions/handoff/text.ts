/** UTF-8 byte clipping helpers for bounded handoff history output. Work is bounded by the byte budget. */

function utf8Length(codePoint: number): number {
	if (codePoint < 0x80) return 1;
	if (codePoint < 0x800) return 2;
	if (codePoint < 0x10000) return 3;
	return 4;
}

/** End index of the longest code-point-safe run of `text` from `from` that fits `maxBytes`. */
function utf8PrefixEnd(text: string, from: number, maxBytes: number): number {
	let bytes = 0;
	let index = from;
	while (index < text.length) {
		const codePoint = text.codePointAt(index) ?? 0;
		const size = utf8Length(codePoint);
		if (bytes + size > maxBytes) break;
		bytes += size;
		index += codePoint > 0xffff ? 2 : 1;
	}
	return index;
}

/** Start index of the longest code-point-safe run of `text` ending at `to` that fits `maxBytes`. */
function utf8SuffixStart(text: string, to: number, maxBytes: number): number {
	let bytes = 0;
	let index = to;
	while (index > 0) {
		let next = index - 1;
		const low = text.charCodeAt(next);
		if (low >= 0xdc00 && low <= 0xdfff && next > 0) {
			const high = text.charCodeAt(next - 1);
			if (high >= 0xd800 && high <= 0xdbff) next--;
		}
		const size = utf8Length(text.codePointAt(next) ?? 0);
		if (bytes + size > maxBytes) break;
		bytes += size;
		index = next;
	}
	return index;
}

function fits(text: string, maxBytes: number): boolean {
	return text.length <= maxBytes / 3 || Buffer.byteLength(text) <= maxBytes;
}

/**
 * Return `text` unchanged when it fits `maxBytes`; otherwise return the longest
 * code-point-safe prefix that fits together with `marker`. The marker counts
 * toward the limit.
 */
export function clipUtf8(text: string, maxBytes: number, marker = "…"): string {
	if (fits(text, maxBytes)) return text;
	return `${text.slice(0, utf8PrefixEnd(text, 0, maxBytes - Buffer.byteLength(marker)))}${marker}`;
}

/** Like `clipUtf8`, but keeps the end of `text`, which is the informative part of a long path. */
export function clipUtf8Start(text: string, maxBytes: number, marker = "…"): string {
	if (fits(text, maxBytes)) return text;
	return `${marker}${text.slice(utf8SuffixStart(text, text.length, maxBytes - Buffer.byteLength(marker)))}`;
}

/** A bounded excerpt and the indices of `text` it covers. */
export interface Utf8Window {
	text: string;
	from: number;
	to: number;
}

/**
 * A window of `text` around the match `[start, end)` within `maxBytes`, with
 * `marker` wherever text is omitted. The match is kept whole and the remaining
 * budget is split between left and right context; a side that runs out of
 * text gives its unused budget to the other. A match too large for the budget
 * keeps its head. `from` and `to` are the covered indices of `text`.
 */
export function utf8Window(text: string, start: number, end: number, maxBytes: number, marker = "…"): Utf8Window {
	const markerBytes = Buffer.byteLength(marker);
	const available = maxBytes - 2 * markerBytes;
	const matchEnd = utf8PrefixEnd(text, start, available);
	if (matchEnd < end) {
		return { text: `${start > 0 ? marker : ""}${text.slice(start, matchEnd)}${marker}`, from: start, to: end };
	}
	const context = available - Buffer.byteLength(text.slice(start, end));
	const leftBudget = Math.floor(context / 2);
	let from = utf8SuffixStart(text, start, leftBudget);
	const leftUsed = from === 0 ? Buffer.byteLength(text.slice(0, start)) : leftBudget;
	const to = utf8PrefixEnd(text, end, context - leftUsed);
	if (to === text.length && from > 0) {
		from = utf8SuffixStart(text, start, context - Buffer.byteLength(text.slice(end, to)));
	}
	return {
		text: `${from > 0 ? marker : ""}${text.slice(from, to)}${to < text.length ? marker : ""}`,
		from,
		to,
	};
}

export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}
