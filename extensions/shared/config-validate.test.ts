import assert from "node:assert/strict";
import test from "node:test";
import { parsePositiveInteger, validateBoundedNumber } from "./config-validate.ts";

test("accepts finite values at inclusive bounds", () => {
	assert.equal(validateBoundedNumber(1, { min: 1, max: 5 }), true);
	assert.equal(validateBoundedNumber(5, { min: 1, max: 5 }), true);
	assert.equal(validateBoundedNumber(2.5, { min: 1, max: 5 }), true);
});

test("rejects non-numbers, non-finite numbers, and values outside the bounds", () => {
	for (const value of ["2", Number.NaN, Number.POSITIVE_INFINITY, 0, 6]) {
		assert.equal(validateBoundedNumber(value, { min: 1, max: 5 }), false);
	}
});

test("enforces the optional integer constraint", () => {
	assert.equal(validateBoundedNumber(2, { integer: true, min: 1, max: 5 }), true);
	assert.equal(validateBoundedNumber(2.5, { integer: true, min: 1, max: 5 }), false);
});

test("parsePositiveInteger parses numbers and numeric strings", () => {
	assert.equal(parsePositiveInteger(1), 1);
	assert.equal(parsePositiveInteger("42"), 42);
	assert.equal(parsePositiveInteger(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("parsePositiveInteger rejects missing, non-positive, non-integer, and invalid values", () => {
	for (const value of [
		undefined,
		null,
		"",
		"   ",
		"abc",
		0,
		"0",
		-1,
		"-5",
		1.5,
		"1.5",
		Number.NaN,
		Number.POSITIVE_INFINITY,
	]) {
		assert.equal(parsePositiveInteger(value), undefined);
	}
});
