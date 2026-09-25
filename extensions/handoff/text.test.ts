import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipUtf8, clipUtf8Start, utf8Window } from "./text.ts";

function windowAround(text: string, match: string, maxBytes: number) {
	const start = text.indexOf(match);
	return utf8Window(text, start, start + match.length, maxBytes);
}

describe("utf8Window", () => {
	it("keeps the match and splits the remaining budget between both sides", () => {
		const text = `${"前".repeat(100)}needle${"後".repeat(100)}`;
		const window = windowAround(text, "needle", 66);

		assert.equal(window.text, `…${"前".repeat(9)}needle${"後".repeat(9)}…`);
		assert.equal(Buffer.byteLength(window.text), 66);
		assert.equal(text.slice(window.from, window.to), `${"前".repeat(9)}needle${"後".repeat(9)}`);
	});

	it("gives unused budget from a short side to the other side", () => {
		const atStart = windowAround(`ab needle ${"z".repeat(100)}`, "needle", 40);
		const atEnd = windowAround(`${"a".repeat(100)} needle zz`, "needle", 40);

		assert.equal(atStart.text, `ab needle ${"z".repeat(24)}…`);
		assert.equal(atEnd.text, `…${"a".repeat(24)} needle zz`);
	});

	it("never splits a surrogate pair and stays within the budget", () => {
		const text = `${"🙂".repeat(50)}x${"🎉".repeat(50)}`;
		for (let maxBytes = 8; maxBytes <= 64; maxBytes++) {
			const window = windowAround(text, "x", maxBytes);
			assert.ok(Buffer.byteLength(window.text) <= maxBytes, `${maxBytes}`);
			assert.ok(window.text.includes("x"));
			assert.ok(!Buffer.from(window.text).toString().includes("\uFFFD"));
		}
	});

	it("keeps the head of a match that exceeds the budget", () => {
		const text = `before ${"x".repeat(100)} after`;
		const window = windowAround(text, "x".repeat(100), 30);

		assert.equal(window.text, `…${"x".repeat(24)}…`);
		assert.deepEqual([window.from, window.to], [7, 107]);
	});

	it("returns short text whole", () => {
		assert.deepEqual(windowAround("a needle b", "needle", 100), { text: "a needle b", from: 0, to: 10 });
	});
});

describe("clipUtf8 and clipUtf8Start", () => {
	it("clip on code-point boundaries with the marker inside the limit", () => {
		assert.equal(clipUtf8("🙂".repeat(10), 12), "🙂🙂…");
		assert.equal(clipUtf8Start("🙂".repeat(10), 12), "…🙂🙂");
		assert.equal(clipUtf8("short", 12), "short");
	});
});
