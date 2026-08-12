import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowLifecycle } from "./lifecycle.ts";

describe("WorkflowLifecycle", () => {
	it("arms cancellation only while a child is running", () => {
		const lifecycle = new WorkflowLifecycle();
		lifecycle.startSession();
		const token = lifecycle.beginWorkflow();
		assert.ok(token);
		if (!token) return;
		assert.equal(lifecycle.currentPhase(), "approval");
		assert.equal(lifecycle.abortActiveChild(), false);

		const planner = lifecycle.beginChild(token, "planning");
		assert.ok(planner);
		assert.equal(lifecycle.abortActiveChild(), true);
		assert.equal(planner?.signal.aborted, true);
		if (planner) lifecycle.endChild(token, planner);
		assert.equal(lifecycle.currentPhase(), "approval");

		const implementer = lifecycle.beginChild(token, "implementing");
		assert.ok(implementer);
		assert.equal(implementer?.signal.aborted, false);
		if (implementer) lifecycle.endChild(token, implementer);

		const fixer = lifecycle.beginChild(token, "fixing");
		assert.ok(fixer);
		assert.equal(lifecycle.currentPhase(), "fixing");
		if (fixer) lifecycle.endChild(token, fixer);

		const publisher = lifecycle.beginChild(token, "publishing");
		assert.ok(publisher);
		assert.equal(lifecycle.currentPhase(), "publishing");
	});

	it("invalidates stale callbacks and aborts the active child on shutdown", () => {
		const lifecycle = new WorkflowLifecycle();
		lifecycle.startSession();
		const token = lifecycle.beginWorkflow();
		assert.ok(token);
		if (!token) return;
		const child = lifecycle.beginChild(token, "planning");
		assert.ok(child);
		lifecycle.shutdownSession();
		assert.equal(child?.signal.aborted, true);
		assert.equal(lifecycle.isCurrent(token), false);
		assert.equal(lifecycle.isSessionCurrent(token), false);

		lifecycle.startSession();
		assert.equal(lifecycle.isCurrent(token), false);
		assert.ok(lifecycle.beginWorkflow());
	});

	it("does not let an old command context start work in a replacement session", () => {
		const lifecycle = new WorkflowLifecycle();
		lifecycle.startSession();
		const oldSession = lifecycle.currentSessionToken();
		assert.ok(oldSession);
		lifecycle.shutdownSession();
		lifecycle.startSession();
		assert.equal(lifecycle.beginWorkflow(oldSession), undefined);
	});

	it("rejects concurrent workflows and returns to idle on finish", () => {
		const lifecycle = new WorkflowLifecycle();
		lifecycle.startSession();
		const token = lifecycle.beginWorkflow();
		assert.ok(token);
		assert.equal(lifecycle.beginWorkflow(), undefined);
		if (!token) return;
		lifecycle.finishWorkflow(token);
		assert.equal(lifecycle.isRunning(), false);
		assert.equal(lifecycle.currentPhase(), "idle");
	});
});
