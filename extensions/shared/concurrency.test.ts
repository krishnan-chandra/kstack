import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrencyLimit } from "./concurrency.ts";

test("returns an empty array without calling fn", async () => {
	let called = 0;
	const result = await mapWithConcurrencyLimit([], 4, async () => {
		called += 1;
		return "unused";
	});
	assert.deepEqual(result, []);
	assert.equal(called, 0);
});

test("keeps input order even when later items finish first", async () => {
	const delays = [30, 5, 15];
	const result = await mapWithConcurrencyLimit(delays, 3, async (delay, index) => {
		await new Promise((resolve) => setTimeout(resolve, delay));
		return `item-${index}`;
	});
	assert.deepEqual(result, ["item-0", "item-1", "item-2"]);
});

test("caps peak concurrency", async () => {
	let running = 0;
	let peak = 0;
	await mapWithConcurrencyLimit([10, 10, 10, 10], 2, async () => {
		running += 1;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 15));
		running -= 1;
		return "ok";
	});
	assert.ok(peak <= 2, `peak concurrency ${peak}`);
	assert.equal(peak, 2);
});

test("treats a non-positive limit as one worker", async () => {
	let running = 0;
	let peak = 0;
	await mapWithConcurrencyLimit([5, 5, 5], 0, async () => {
		running += 1;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, 10));
		running -= 1;
		return "ok";
	});
	assert.equal(peak, 1);
});

test("rejects the whole call when fn rejects", async () => {
	await assert.rejects(
		mapWithConcurrencyLimit([1, 2, 3], 2, async (item) => {
			if (item === 2) throw new Error("boom");
			return item;
		}),
		/boom/,
	);
});
