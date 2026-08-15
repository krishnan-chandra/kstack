import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RouterLifecycle } from "./lifecycle.ts";

describe("RouterLifecycle", () => {
	it("issues a session token only while a session is active", () => {
		const lifecycle = new RouterLifecycle();
		assert.equal(lifecycle.sessionToken(), undefined);
		lifecycle.startSession();
		assert.ok(lifecycle.sessionToken());
		lifecycle.shutdownSession();
		assert.equal(lifecycle.sessionToken(), undefined);
	});

	it("tracks the active dispatch route and tool snapshot", () => {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const session = lifecycle.sessionToken();
		assert.ok(session);

		const token = lifecycle.beginDispatch(session, { route: "investigate", toolSnapshot: ["read", "grep", "bash"] });
		assert.ok(token);

		const active = lifecycle.getActiveDispatch();
		assert.equal(active?.route, "investigate");
		assert.deepEqual(lifecycle.getToolSnapshot(), { tools: ["read", "grep", "bash"] });

		lifecycle.endDispatch(token);
		assert.equal(lifecycle.getActiveDispatch(), undefined);
		assert.equal(lifecycle.getToolSnapshot(), undefined);
	});

	it("rejects a second concurrent dispatch", () => {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const session = lifecycle.sessionToken();
		assert.ok(session);

		const first = lifecycle.beginDispatch(session, { route: "change" });
		assert.ok(first);
		assert.equal(lifecycle.beginDispatch(session, { route: "review" }), undefined);
		lifecycle.endDispatch(first);
		assert.ok(lifecycle.beginDispatch(session, { route: "review" }));
	});

	it("invalidates dispatches across session replacement", () => {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const session = lifecycle.sessionToken();
		assert.ok(session);

		const token = lifecycle.beginDispatch(session, { route: "swarm", toolSnapshot: ["read"] });
		assert.ok(token);

		// Session shutdown ends everything; the old token can no longer act.
		lifecycle.shutdownSession();
		assert.equal(lifecycle.getActiveDispatch(), undefined);
		assert.equal(lifecycle.getToolSnapshot(), undefined);
		assert.equal(lifecycle.isCurrentDispatch(token), false);
		lifecycle.endDispatch(token); // no-op, must not throw

		lifecycle.startSession();
		assert.equal(lifecycle.isSessionCurrent(session), false);
	});

	it("endDispatch ignores foreign tokens", () => {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const session = lifecycle.sessionToken();
		assert.ok(session);

		const token = lifecycle.beginDispatch(session, { route: "arena" });
		assert.ok(token);
		lifecycle.endDispatch({ generation: 999, dispatchId: "dispatch-999" });
		assert.ok(lifecycle.getActiveDispatch());
	});

	it("aborts the active classifier exactly once", () => {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const session = lifecycle.sessionToken();
		assert.ok(session);

		const controller = lifecycle.beginClassifier(session);
		assert.ok(controller);
		assert.equal(lifecycle.beginClassifier(session), undefined, "no concurrent classifiers");
		assert.equal(lifecycle.abortClassifier(), true);
		assert.ok(controller.signal.aborted);
		assert.equal(lifecycle.abortClassifier(), false);
		lifecycle.endClassifier(session);
		assert.ok(lifecycle.beginDispatch(session, { route: "investigate" }));
	});

	it("aborts classification when a replacement session starts", () => {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const firstToken = lifecycle.sessionToken();
		assert.ok(firstToken);

		const controller = lifecycle.beginClassifier(firstToken);
		assert.ok(controller);
		assert.equal(controller.signal.aborted, false);

		lifecycle.startSession();
		assert.ok(controller.signal.aborted);
		assert.equal(lifecycle.isSessionCurrent(firstToken), false);
		assert.equal(lifecycle.abortClassifier(), false);

		const nextToken = lifecycle.sessionToken();
		assert.ok(nextToken);
		assert.ok(lifecycle.beginClassifier(nextToken));
	});

	it("does not overlap classification and dispatch", () => {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const session = lifecycle.sessionToken();
		assert.ok(session);

		assert.ok(lifecycle.beginClassifier(session));
		assert.equal(lifecycle.beginDispatch(session, { route: "change" }), undefined);
		lifecycle.endClassifier(session);

		const dispatch = lifecycle.beginDispatch(session, { route: "change" });
		assert.ok(dispatch);
		assert.equal(lifecycle.beginClassifier(session), undefined);
	});
});
