import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PanelLifecycle } from "./lifecycle.ts";

describe("panel-review lifecycle", () => {
	it("invalidates a session token on shutdown", () => {
		const lifecycle = new PanelLifecycle();
		lifecycle.startSession();
		const token = lifecycle.currentSessionToken()!;
		lifecycle.shutdownSession();
		assert.equal(lifecycle.isSessionCurrent(token), false);
	});

	it("rejects a second run while one is active", () => {
		const lifecycle = new PanelLifecycle();
		lifecycle.startSession();
		const session = lifecycle.currentSessionToken()!;
		assert.ok(lifecycle.beginRun(session));
		assert.equal(lifecycle.beginRun(session), undefined);
	});

	it("ends the current run idempotently", () => {
		const lifecycle = new PanelLifecycle();
		lifecycle.startSession();
		const run = lifecycle.beginRun(lifecycle.currentSessionToken()!)!;
		lifecycle.endRun(run);
		lifecycle.endRun(run);
		assert.equal(lifecycle.isRunning(), false);
	});

	it("does not consider a stale run token current", () => {
		const lifecycle = new PanelLifecycle();
		lifecycle.startSession();
		const run = lifecycle.beginRun(lifecycle.currentSessionToken()!)!;
		lifecycle.shutdownSession();
		lifecycle.startSession();
		assert.equal(lifecycle.isCurrent(run), false);
	});
});
