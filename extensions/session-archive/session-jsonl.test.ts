import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_TEXT_CONTENT_CHARS,
	parseSessionJsonl,
	parseSessionJsonlBytes,
	SessionParseError,
	sha256Hex,
} from "./session-jsonl.ts";
import { messageEntry, richSessionJsonl, sessionJsonl, userMessage } from "./test-helpers.ts";

describe("parseSessionJsonl", () => {
	it("parses a valid v3 session with tree entries", () => {
		const parsed = parseSessionJsonl(richSessionJsonl());
		assert.equal(parsed.header.id, "019ff001-deb2-7696-997e-8684026835d1");
		assert.equal(parsed.header.cwd, "/Users/test/Code/project");
		assert.equal(parsed.entries.length, 12);
		assert.equal(parsed.entries[1].entryId, "u1");
		assert.equal(parsed.entries[1].parentId, "m0");
	});

	it("records byte ranges that recover every raw entry line exactly", () => {
		const content = richSessionJsonl();
		const bytes = Buffer.from(content);
		const parsed = parseSessionJsonlBytes(bytes);
		const lines = content.trim().split("\n").slice(1);
		for (let i = 0; i < parsed.entries.length; i++) {
			const entry = parsed.entries[i];
			assert.equal(bytes.subarray(entry.rawOffset, entry.rawOffset + entry.rawLength).toString("utf8"), lines[i]);
		}
	});

	it("uses byte rather than character offsets across blank and multibyte lines", () => {
		const content = sessionJsonl([
			messageEntry("u1", null, userMessage("héllo 👋")),
			messageEntry("u2", "u1", userMessage("second")),
		]).replace('\n{"type":"message"', '\n  \n{"type":"message"');
		const bytes = Buffer.from(content);
		for (const entry of parseSessionJsonlBytes(bytes).entries) {
			const raw = bytes.subarray(entry.rawOffset, entry.rawOffset + entry.rawLength).toString("utf8");
			assert.equal(JSON.parse(raw).id, entry.entryId);
		}
	});

	it("rejects empty, malformed, duplicate, and incomplete documents", () => {
		assert.throws(() => parseSessionJsonl(""), SessionParseError);
		assert.throws(() => parseSessionJsonl('{"type":"message"}\n'), /first line/);
		const header = sessionJsonl([]).trim();
		assert.throws(() => parseSessionJsonl(`${header}\n${header}\n`), /only appear on the first line/);
		assert.throws(
			() => parseSessionJsonl(sessionJsonl([messageEntry("u1", null, userMessage("x"))]).slice(0, -20)),
			SessionParseError,
		);
		assert.throws(
			() =>
				parseSessionJsonl(
					sessionJsonl([messageEntry("dup", null, userMessage("a")), messageEntry("dup", null, userMessage("b"))]),
				),
			/duplicate entry id/,
		);
		assert.throws(
			() =>
				parseSessionJsonl(
					sessionJsonl([
						{ type: "message", parentId: null, timestamp: "2026-08-11T08:49:00.000Z", message: userMessage("x") },
					]),
				),
			/"id"/,
		);
		assert.throws(
			() => parseSessionJsonl(sessionJsonl([{ type: "label", id: "l1", parentId: null, targetId: "x" }])),
			/"timestamp"/,
		);
	});

	it("rejects invalid UTF-8 and non-v3 sessions", () => {
		const valid = Buffer.from(sessionJsonl([]));
		const corrupted = Buffer.concat([
			valid.subarray(0, valid.length - 2),
			Buffer.from([0xff]),
			valid.subarray(valid.length - 2),
		]);
		assert.throws(() => parseSessionJsonlBytes(corrupted), /not valid UTF-8/);
		for (const version of [1, 2, 4]) {
			assert.throws(() => parseSessionJsonl(sessionJsonl([], { version })), /unsupported session version/);
		}
	});

	it("accepts a header-only v3 session", () => {
		assert.equal(parseSessionJsonl(sessionJsonl([])).entries.length, 0);
	});
});

describe("text extraction", () => {
	const content = richSessionJsonl();
	const parsed = parseSessionJsonl(content);
	const byId = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));

	it("extracts searchable text without thinking, tool calls, or image data", () => {
		assert.equal(byId.get("u1")?.textContent, "hello archive world");
		assert.equal(byId.get("a1")?.textContent, "hi there, archiving works");
		assert.equal(byId.get("t1")?.textContent, "total 42 files listed");
		assert.equal(byId.get("b1")?.textContent, "$ echo archive-marker\narchive-marker");
		assert.equal(byId.get("img1")?.textContent, "look at this screenshot");
		assert.ok(!byId.get("img1")?.textContent?.includes("aGVsbG8"));
	});

	it("extracts summaries, custom messages, labels, and session names", () => {
		assert.equal(byId.get("c1")?.textContent, "user discussed archiving markers");
		assert.equal(byId.get("s1")?.textContent, "branch explored alternate archive layout");
		assert.equal(byId.get("x1")?.textContent, "injected archive context");
		assert.equal(byId.get("x2")?.textContent, undefined);
		assert.equal(byId.get("l1")?.textContent, "checkpoint-one");
		assert.equal(byId.get("n1")?.sessionNamePresent, true);
		assert.equal(byId.get("n1")?.sessionName, "archive test session");
	});

	it("leaves non-searchable entries without text", () => {
		assert.equal(byId.get("m0")?.textContent, undefined);
	});

	it("caps pathological search text while retaining the source range", () => {
		const huge = "x".repeat(MAX_TEXT_CONTENT_CHARS + 100);
		const entry = parseSessionJsonl(sessionJsonl([messageEntry("u1", null, userMessage(huge))])).entries[0];
		assert.equal(entry.textContent?.length, MAX_TEXT_CONTENT_CHARS);
		assert.ok(entry.rawLength > MAX_TEXT_CONTENT_CHARS);
	});
});

describe("sha256Hex", () => {
	it("hashes deterministically", () => {
		assert.equal(sha256Hex("abc"), sha256Hex(Buffer.from("abc")));
		assert.notEqual(sha256Hex("abc"), sha256Hex("abd"));
	});
});
