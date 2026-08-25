import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AutopilotLifecycle } from "./lifecycle.ts";

describe("pr-autopilot lifecycle", () => {
	it("starts as not running", () => {
		const lc = new AutopilotLifecycle();
		assert.equal(lc.isRunning(), false);
		assert.equal(lc.currentSessionToken(), undefined);
	});

	it("starts a session and issues tokens", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		assert.equal(lc.isRunning(), false);
		const token = lc.currentSessionToken();
		assert.ok(token);
		assert.equal(lc.isSessionCurrent(token!), true);
	});

	it("beginRun returns a token and sets running", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		const runToken = lc.beginRun(sessionToken);
		assert.ok(runToken);
		assert.equal(lc.isRunning(), true);
	});

	it("beginRun fails when a run is already active", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		lc.beginRun(sessionToken);
		// Second beginRun on the same session should fail (already running).
		const second = lc.beginRun(sessionToken);
		assert.equal(second, undefined);
	});

	it("beginRun fails with a stale session token", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const staleToken = { generation: 999 };
		assert.equal(lc.beginRun(staleToken), undefined);
	});

	it("endRun clears the running flag", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		const runToken = lc.beginRun(sessionToken)!;
		lc.endRun(runToken);
		assert.equal(lc.isRunning(), false);
	});

	it("shutdownSession invalidates tokens", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		lc.shutdownSession();
		assert.equal(lc.isSessionCurrent(sessionToken), false);
		assert.equal(lc.currentSessionToken(), undefined);
	});

	it("isCurrent is true only while a run is active on this session", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		assert.equal(lc.isCurrent(sessionToken), false);
		const runToken = lc.beginRun(sessionToken)!;
		assert.equal(lc.isCurrent(runToken), true);
		lc.endRun(runToken);
		assert.equal(lc.isCurrent(runToken), false);
	});

	it("composed AbortSignal.any is aborted when either constituent is aborted", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		const runToken = lc.beginRun(sessionToken)!;
		const lifecycleSignal = lc.runSignal(runToken)!;
		const callerController = new AbortController();
		const composed = AbortSignal.any([lifecycleSignal, callerController.signal]);

		// Initially not aborted.
		assert.equal(composed.aborted, false);

		// Aborting the caller aborts the composed signal.
		callerController.abort();
		assert.equal(composed.aborted, true);
		lc.endRun(runToken);
	});

	it("composed AbortSignal.any is immediately aborted when the caller signal is pre-aborted", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		const runToken = lc.beginRun(sessionToken)!;
		const lifecycleSignal = lc.runSignal(runToken)!;

		// Pre-abort the caller signal before composing.
		const preAbortedController = new AbortController();
		preAbortedController.abort();
		const composed = AbortSignal.any([lifecycleSignal, preAbortedController.signal]);

		assert.equal(composed.aborted, true);
		lc.endRun(runToken);
	});

	it("aborting the lifecycle run aborts the lifecycle signal and therefore the composed signal", () => {
		const lc = new AutopilotLifecycle();
		lc.startSession();
		const sessionToken = lc.currentSessionToken()!;
		const runToken = lc.beginRun(sessionToken)!;
		const lifecycleSignal = lc.runSignal(runToken)!;
		const callerController = new AbortController();
		const composed = AbortSignal.any([lifecycleSignal, callerController.signal]);

		assert.equal(composed.aborted, false);
		lc.abortRun();
		// The composed signal should be aborted because the lifecycle signal was aborted by abortRun.
		assert.equal(composed.aborted, true);
		lc.endRun(runToken);
	});
});
