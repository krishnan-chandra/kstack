import assert from "node:assert/strict";
import test from "node:test";
import { LandLifecycle } from "./lifecycle.ts";

test("end releases the run without turning normal completion into an abort", () => {
	const lifecycle = new LandLifecycle();
	lifecycle.startSession();
	const token = lifecycle.begin();
	assert.ok(token);
	lifecycle.end(token);
	assert.equal(token.signal.aborted, false);
	assert.equal(lifecycle.isRunning(), false);
});

test("allows one active run and shutdown aborts it", () => {
	const lifecycle = new LandLifecycle();
	lifecycle.startSession();
	const token = lifecycle.begin();
	assert.ok(token);
	assert.equal(lifecycle.begin(), undefined);
	lifecycle.shutdownSession();
	assert.equal(token.signal.aborted, true);
});

test("starting a replacement session aborts the active run", () => {
	const lifecycle = new LandLifecycle();
	lifecycle.startSession();
	const token = lifecycle.begin();
	assert.ok(token);

	lifecycle.startSession();

	assert.equal(token.signal.aborted, true);
	assert.equal(lifecycle.isRunning(), false);
});

test("abort returns false while idle and after the run is already aborted", () => {
	const lifecycle = new LandLifecycle();
	lifecycle.startSession();
	assert.equal(lifecycle.abort(), false);
	const token = lifecycle.begin();
	assert.ok(token);
	assert.equal(lifecycle.abort(), true);
	assert.equal(lifecycle.abort(), false);
});
