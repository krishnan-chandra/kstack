import assert from "node:assert/strict";
import test from "node:test";
import { planIdFor } from "./plan-id.ts";

test("plan IDs are independent of object key insertion order", () => {
	assert.equal(
		planIdFor(1, { a: 1, nested: { x: true, y: "yes" } }),
		planIdFor(1, { nested: { y: "yes", x: true }, a: 1 }),
	);
});

test("plan ID versions use distinct hash domains", () => {
	assert.notEqual(planIdFor(1, { a: 1 }), planIdFor(2, { a: 1 }));
});

test("plan facts reject values without a canonical JSON representation", () => {
	assert.throws(() => planIdFor(1, { missing: undefined }), /must not contain undefined/);
	assert.throws(() => planIdFor(1, Number.NaN), /finite numbers/);
});

test("plan facts reject sparse arrays rather than hashing them as empty arrays", () => {
	assert.throws(() => planIdFor(1, Array(1)), /undefined array entries/);
});

test("plan facts reject non-JSON objects rather than hashing them as empty objects", () => {
	assert.throws(() => planIdFor(1, new Date(0)), /plain JSON objects/);
});
