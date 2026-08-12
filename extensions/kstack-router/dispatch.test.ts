import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchRoute, getRestrictedTools } from "./dispatch.ts";
import { RouterLifecycle } from "./lifecycle.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

describe("getRestrictedTools", () => {
	const active = ["read", "grep", "find", "ls", "bash", "edit", "write", "read_handoff_history", "search_session_archive"];

	it("intersects with the base read-only allowlist", () => {
		assert.deepEqual(getRestrictedTools("investigate", active), ["read", "grep", "find", "ls"]);
	});

	it("session-pickup also allows already-active handoff/archive tools", () => {
		assert.deepEqual(getRestrictedTools("session-pickup", active), [
			"read",
			"grep",
			"find",
			"ls",
			"read_handoff_history",
			"search_session_archive",
		]);
	});

	it("never enables tools the user had disabled", () => {
		assert.deepEqual(getRestrictedTools("investigate", ["bash", "read"]), ["read"]);
		assert.deepEqual(getRestrictedTools("session-pickup", ["read"]), ["read"]);
		assert.deepEqual(getRestrictedTools("investigate", ["bash"]), []);
	});
});

describe("dispatchRoute", () => {
	function setup() {
		const lifecycle = new RouterLifecycle();
		lifecycle.startSession();
		const session = lifecycle.sessionToken();
		assert.ok(session);
		const token = lifecycle.beginDispatch(session, { route: "investigate" });
		assert.ok(token);
		return { lifecycle, session, token };
	}

	const pi = {} as ExtensionAPI;
	const ctx = {} as ExtensionCommandContext;

	it("fails closed for active-session routes (handled by the command handler)", async () => {
		const { lifecycle, token } = setup();
		const result = await dispatchRoute("investigate", "task", undefined, "generic", token, lifecycle, pi, ctx);
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /active-session route/);
	});

	it("unsupported explains the bounded routes without dispatching", async () => {
		const { lifecycle, token } = setup();
		const result = await dispatchRoute("unsupported", "task", undefined, "generic", token, lifecycle, pi, ctx);
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /does not fit a supported route/);
	});

	it("aborts when the dispatch token is stale", async () => {
		const { lifecycle, token } = setup();
		lifecycle.endDispatch(token);
		const result = await dispatchRoute("review", "task", undefined, "generic", token, lifecycle, pi, ctx);
		assert.equal(result.status, "aborted");
	});
});
