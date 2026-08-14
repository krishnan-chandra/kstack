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

test("owns one signal for the active run", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);
	const run = lifecycle.beginRun(session);
	assert.ok(run);

	const signal = lifecycle.runSignal(run);
	assert.ok(signal);
	assert.equal(signal.aborted, false);
	assert.equal(lifecycle.beginRun(session), undefined);
});

test("aborts the active run at most once", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);
	const run = lifecycle.beginRun(session);
	assert.ok(run);
	const signal = lifecycle.runSignal(run);
	assert.ok(signal);

	assert.equal(lifecycle.abortRun(), true);
	assert.equal(signal.aborted, true);
	assert.equal(lifecycle.abortRun(), false);
});

test("normal completion releases the signal without aborting it", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);
	const run = lifecycle.beginRun(session);
	assert.ok(run);
	const signal = lifecycle.runSignal(run);
	assert.ok(signal);

	lifecycle.endRun(run);

	assert.equal(signal.aborted, false);
	assert.equal(lifecycle.runSignal(run), undefined);
});

test("shutdown aborts the active run", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);
	const run = lifecycle.beginRun(session);
	assert.ok(run);
	const signal = lifecycle.runSignal(run);
	assert.ok(signal);

	lifecycle.shutdownSession();

	assert.equal(signal.aborted, true);
	assert.equal(lifecycle.runSignal(run), undefined);
});

test("starting a replacement session aborts the previous run", () => {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	const session = lifecycle.currentSessionToken();
	assert.ok(session);
	const run = lifecycle.beginRun(session);
	assert.ok(run);
	const signal = lifecycle.runSignal(run);
	assert.ok(signal);

	lifecycle.startSession();

	assert.equal(signal.aborted, true);
	assert.equal(lifecycle.runSignal(run), undefined);
});

test("does not expose a signal for a stale token", () => {
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
	assert.ok(lifecycle.beginRun(secondSession));

	assert.equal(lifecycle.runSignal(firstRun), undefined);
});
