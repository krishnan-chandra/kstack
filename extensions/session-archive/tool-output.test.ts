import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitUtf8Chunks } from "./tool-output.ts";

describe("splitUtf8Chunks", () => {
	it("returns bounded chunks that reconstruct the exact input", () => {
		const input = `${"x".repeat(100)}🙂${"y".repeat(100)}é${"z".repeat(100)}`;
		const chunks = splitUtf8Chunks(input, 31);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 31));
		assert.equal(chunks.join(""), input);
	});

	it("returns one empty chunk for empty output", () => {
		assert.deepEqual(splitUtf8Chunks("", 32), [""]);
	});
});
