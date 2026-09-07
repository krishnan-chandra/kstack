import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_COLUMN_COLUMNS, placeAgent } from "./layout.ts";

describe("placeAgent", () => {
	it("places agent 0 on the root pane for every total", () => {
		for (const total of [1, 2, 3, 4, 5, 6, 7, 8]) {
			assert.equal(placeAgent(0, total, { widthColumns: 240 }), undefined);
		}
	});

	it("returns undefined outside the 1..8 agent bound", () => {
		assert.equal(placeAgent(0, 0, { widthColumns: 240 }), undefined);
		assert.equal(placeAgent(0, 9, { widthColumns: 240 }), undefined);
		assert.equal(placeAgent(9, 9, { widthColumns: 240 }), undefined);
		assert.equal(placeAgent(2, 2, { widthColumns: 240 }), undefined);
		assert.equal(placeAgent(-1, 2, { widthColumns: 240 }), undefined);
	});

	it("uses two columns for two agents", () => {
		assert.deepEqual(placeAgent(1, 2, { widthColumns: 240 }), {
			splitFrom: "root",
			direction: "right",
			ratio: 0.5,
		});
	});

	it("fills two columns down for three and four agents", () => {
		assert.deepEqual(placeAgent(1, 4, { widthColumns: 240 }), { splitFrom: "root", direction: "right", ratio: 0.5 });
		assert.deepEqual(placeAgent(2, 4, { widthColumns: 240 }), { splitFrom: 0, direction: "down", ratio: 0.5 });
		assert.deepEqual(placeAgent(3, 4, { widthColumns: 240 }), { splitFrom: 1, direction: "down", ratio: 0.5 });
	});

	it("creates a third column for five and six agents", () => {
		assert.deepEqual(placeAgent(1, 6, { widthColumns: 240 }), { splitFrom: "root", direction: "right", ratio: 1 / 3 });
		assert.deepEqual(placeAgent(2, 6, { widthColumns: 240 }), { splitFrom: 1, direction: "right", ratio: 0.5 });
		assert.deepEqual(placeAgent(3, 6, { widthColumns: 240 }), { splitFrom: 0, direction: "down", ratio: 0.5 });
		assert.deepEqual(placeAgent(4, 6, { widthColumns: 240 }), { splitFrom: 1, direction: "down", ratio: 0.5 });
		assert.deepEqual(placeAgent(5, 6, { widthColumns: 240 }), { splitFrom: 2, direction: "down", ratio: 0.5 });
	});

	it("stacks seven and eight agents three wide", () => {
		assert.deepEqual(placeAgent(6, 8, { widthColumns: 240 }), { splitFrom: 3, direction: "down", ratio: 0.5 });
		assert.deepEqual(placeAgent(7, 8, { widthColumns: 240 }), { splitFrom: 4, direction: "down", ratio: 0.5 });
	});

	it("falls back to one column in a narrow tab so panes stay readable", () => {
		const narrow = { widthColumns: MIN_COLUMN_COLUMNS * 2 - 1 };
		assert.deepEqual(placeAgent(1, 4, narrow), { splitFrom: 0, direction: "down", ratio: 0.25 });
		assert.deepEqual(placeAgent(2, 4, narrow), { splitFrom: 1, direction: "down", ratio: 1 / 3 });
		assert.deepEqual(placeAgent(3, 4, narrow), { splitFrom: 2, direction: "down", ratio: 0.5 });
	});

	it("falls back to two columns when only two fit", () => {
		const width = { widthColumns: MIN_COLUMN_COLUMNS * 2 + 10 };
		assert.deepEqual(placeAgent(1, 6, width), { splitFrom: "root", direction: "right", ratio: 0.5 });
		assert.deepEqual(placeAgent(2, 6, width), { splitFrom: 0, direction: "down", ratio: 1 / 3 });
		assert.deepEqual(placeAgent(3, 6, width), { splitFrom: 1, direction: "down", ratio: 1 / 3 });
		assert.deepEqual(placeAgent(4, 6, width), { splitFrom: 2, direction: "down", ratio: 0.5 });
		assert.deepEqual(placeAgent(5, 6, width), { splitFrom: 3, direction: "down", ratio: 0.5 });
	});

	it("keeps every ratio strictly between 0 and 1 for all supported totals", () => {
		for (let total = 1; total <= 8; total++) {
			for (let index = 1; index < total; index++) {
				const placement = placeAgent(index, total, { widthColumns: 600 });
				assert.ok(placement, `${index}/${total}`);
				assert.ok(placement.ratio > 0 && placement.ratio < 1);
				if (placement.splitFrom !== "root") assert.ok(placement.splitFrom >= 0 && placement.splitFrom < index);
			}
		}
	});
});
