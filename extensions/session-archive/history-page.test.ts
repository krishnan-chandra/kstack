import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatHistoryEntries,
	formatHistoryEntry,
	type HistoryEntry,
	historyPageNextLabel,
	selectHistoryPage,
} from "./history-page.ts";

function entry(
	overrides: Partial<{
		ordinal: number;
		entryType: string;
		role: string | null;
		timestamp: string;
		entryId: string;
		parentId: string | null;
		textContent: string | null;
	}> = {},
): HistoryEntry {
	return {
		ordinal: 1,
		entryType: "message",
		role: "user",
		timestamp: "2026-09-09T00:00:00.000Z",
		entryId: "e1",
		parentId: null,
		textContent: "hello",
		...overrides,
	};
}

describe("formatHistoryEntry", () => {
	it("formats role, parent, and text on separate header and body lines", () => {
		assert.equal(
			formatHistoryEntry(entry({ parentId: "p1", textContent: "resume work" })),
			"#1 [message/user] 2026-09-09T00:00:00.000Z (id e1, parent p1)\nresume work",
		);
	});

	it("omits missing role, empty text, and labels a missing parent as none", () => {
		assert.equal(
			formatHistoryEntry(entry({ role: null, parentId: null, textContent: "" })),
			"#1 [message] 2026-09-09T00:00:00.000Z (id e1, parent none)",
		);
	});

	it("joins a page of entries with a blank line", () => {
		assert.equal(
			formatHistoryEntries([entry(), entry({ ordinal: 2, entryId: "e2", textContent: "next" })]),
			"#1 [message/user] 2026-09-09T00:00:00.000Z (id e1, parent none)\nhello\n\n" +
				"#2 [message/user] 2026-09-09T00:00:00.000Z (id e2, parent none)\nnext",
		);
	});
});

describe("selectHistoryPage", () => {
	it("reconstructs UTF-8 text across continuation chunks", () => {
		const body = formatHistoryEntries([
			entry({ textContent: `héllo ${"語".repeat(80)}` }),
			entry({ ordinal: 2, entryId: "e2", textContent: "tail" }),
		]);
		let chunk = 0;
		let reconstructed = "";
		let pages = 0;
		while (true) {
			const page = selectHistoryPage({
				body,
				offset: 0,
				pageEntries: 2,
				totalEntries: 2,
				chunk,
				maxBytes: 80,
			});
			assert.equal(page.ok, true);
			if (!page.ok) break;
			assert.ok(Buffer.byteLength(page.body) <= 80);
			assert.ok(!page.body.includes("�"));
			reconstructed += page.body;
			pages += 1;
			if (page.next === null) break;
			assert.equal(page.next.offset, 0);
			assert.equal(
				historyPageNextLabel(page.next, { end: "end of session" }),
				`continue with the same offset/limit and chunk ${page.next.chunk}`,
			);
			chunk = page.next.chunk;
		}
		assert.ok(pages > 1);
		assert.equal(reconstructed, body);
	});

	it("advances the entry offset after the last chunk of a partial page", () => {
		const body = formatHistoryEntries([entry(), entry({ ordinal: 2, entryId: "e2" })]);
		const page = selectHistoryPage({
			body,
			offset: 10,
			pageEntries: 2,
			totalEntries: 40,
			chunk: 0,
			maxBytes: 50_000,
		});
		assert.deepEqual(page, {
			ok: true,
			body,
			chunk: 0,
			chunks: 1,
			next: { offset: 12, chunk: 0 },
			range: "entries 11–12 of 40",
		});
		assert.equal(historyPageNextLabel(page.next, { end: "end of session" }), "continue with offset 12 and chunk 0");
		assert.equal(
			historyPageNextLabel(page.next, { end: "end of session", fromStart: true }),
			"continue with offset 12, from=start, and chunk 0",
		);
	});

	it("reports the end of a session on the last chunk of the last entries", () => {
		const page = selectHistoryPage({
			body: formatHistoryEntries([entry()]),
			offset: 4,
			pageEntries: 1,
			totalEntries: 5,
			chunk: 0,
			maxBytes: 50_000,
		});
		assert.equal(page.ok, true);
		if (!page.ok) return;
		assert.equal(page.next, null);
		assert.equal(page.range, "entries 5–5 of 5");
		assert.equal(historyPageNextLabel(page.next, { end: "end of session" }), "end of session");
	});

	it("rejects an out-of-range chunk", () => {
		assert.deepEqual(
			selectHistoryPage({
				body: formatHistoryEntries([entry()]),
				offset: 0,
				pageEntries: 1,
				totalEntries: 1,
				chunk: 999,
				maxBytes: 50_000,
			}),
			{ ok: false, reason: "Chunk 999 is out of range; this page has 1 chunk(s)." },
		);
	});

	it("treats an empty page as one empty chunk", () => {
		assert.deepEqual(
			selectHistoryPage({
				body: "",
				offset: 5,
				pageEntries: 0,
				totalEntries: 5,
				chunk: 0,
				maxBytes: 32,
			}),
			{ ok: true, body: "", chunk: 0, chunks: 1, next: null, range: "no entries" },
		);
	});
});
