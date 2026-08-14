import assert from "node:assert/strict";
import test from "node:test";
import { LandLifecycle } from "./lifecycle.ts";

test("end aborts outstanding work before releasing the run", () => {
	const lifecycle = new LandLifecycle(); lifecycle.startSession();
	const token = lifecycle.begin(); assert.ok(token);
	lifecycle.end(token);
	assert.equal(token.signal.aborted, true);
	assert.equal(lifecycle.isRunning(), false);
});

test("allows one active run and shutdown aborts it", () => {
	const lifecycle = new LandLifecycle(); lifecycle.startSession();
	const token = lifecycle.begin(); assert.ok(token); assert.equal(lifecycle.begin(), undefined);
	lifecycle.shutdown(); assert.equal(token.signal.aborted, true);
});
