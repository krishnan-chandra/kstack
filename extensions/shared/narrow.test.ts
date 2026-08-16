import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asRecord, isRecord } from "./narrow.ts";

describe("JSON narrowing helpers", () => {
	it("accepts records", () => {
		const value = { key: "value" };
		assert.equal(isRecord(value), true);
		assert.equal(asRecord(value), value);
	});

	it("rejects non-record values", () => {
		for (const value of [null, [], "text", 42, undefined]) {
			assert.equal(isRecord(value), false);
			assert.equal(asRecord(value), undefined);
		}
	});
});
