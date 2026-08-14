import assert from "node:assert/strict";
import test from "node:test";
import { SessionRunLifecycle } from "./session-lifecycle.ts";

test("invalidates tokens when a session shuts down", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);
	const run = lifecycle.beginRun(session);
	assert.ok(run);

	lifecycle.shutdownSession();

	assert.equal(lifecycle.isSessionCurrent(session), false);
	assert.equal(lifecycle.isCurrent(run), false);
	assert.equal(lifecycle.isRunning(), false);
});

test("allows only one run at a time", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);

	assert.ok(lifecycle.beginRun(session));
	assert.equal(lifecycle.beginRun(session), undefined);
});

test("rejects stale session tokens", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const stale = lifecycle.currentSessionToken();
	assert.ok(stale);
	lifecycle.shutdownSession();
	lifecycle.startSession();

	assert.equal(lifecycle.beginRun(stale), undefined);
});

test("ends only the run from the current generation", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const firstSession = lifecycle.currentSessionToken();
	assert.ok(firstSession);
	const firstRun = lifecycle.beginRun(firstSession);
	assert.ok(firstRun);
	lifecycle.shutdownSession();
	lifecycle.startSession();
	const secondSession = lifecycle.currentSessionToken();
	assert.ok(secondSession);
	const secondRun = lifecycle.beginRun(secondSession);
	assert.ok(secondRun);

	lifecycle.endRun(firstRun);
	assert.equal(lifecycle.isRunning(), true);
	lifecycle.endRun(secondRun);
	lifecycle.endRun(secondRun);
	assert.equal(lifecycle.isRunning(), false);
});

test("a session token is not current as a run before beginRun", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);

	assert.equal(lifecycle.isCurrent(session), false);
});
