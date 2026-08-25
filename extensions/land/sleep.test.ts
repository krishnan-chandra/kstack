import assert from "node:assert/strict";
import test from "node:test";
import { abortableSleep } from "./sleep.ts";

test("rejects immediately for an already-aborted signal", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(abortableSleep(10_000, controller.signal), /aborted/);
});

test("removes its listener after the timer resolves", async () => {
	const controller = new AbortController();
	let added = 0;
	let removed = 0;
	const signal = controller.signal;
	const originalAdd = signal.addEventListener.bind(signal);
	const originalRemove = signal.removeEventListener.bind(signal);
	signal.addEventListener = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ((
		...args: Parameters<AbortSignal["addEventListener"]>
	) => {
		added++;
		return originalAdd(...args);
	}) as AbortSignal["addEventListener"];
	signal.removeEventListener = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ((
		...args: Parameters<AbortSignal["removeEventListener"]>
	) => {
		removed++;
		return originalRemove(...args);
	}) as AbortSignal["removeEventListener"];
	await abortableSleep(1, signal);
	assert.equal(added, 1);
	assert.equal(removed, 1);
});
