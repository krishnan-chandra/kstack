import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LAND_REQUEST_EVENT } from "../land/api.ts";
import { PRAUTOPILOT_REQUEST_EVENT } from "../pr-autopilot/api.ts";
import { dispatchRoute, getRestrictedTools } from "./dispatch.ts";
import { RouterLifecycle } from "./lifecycle.ts";

describe("getRestrictedTools", () => {
	const active = [
		"read",
		"grep",
		"find",
		"ls",
		"bash",
		"edit",
		"write",
		"read_handoff_history",
		"search_session_archive",
	];

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
		const result = await dispatchRoute("investigate", "task", undefined, false, "generic", token, lifecycle, pi, ctx);
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /active-session route/);
	});

	it("unsupported explains the bounded routes without dispatching", async () => {
		const { lifecycle, token } = setup();
		const result = await dispatchRoute("unsupported", "task", undefined, false, "generic", token, lifecycle, pi, ctx);
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /does not fit a supported route/);
	});

	it("aborts when the dispatch token is stale", async () => {
		const { lifecycle, token } = setup();
		lifecycle.endDispatch(token);
		const result = await dispatchRoute("review", "task", undefined, false, "generic", token, lifecycle, pi, ctx);
		assert.equal(result.status, "aborted");
	});

	it("dispatches pr-autopilot through the typed request channel", async () => {
		const { lifecycle, token } = setup();
		const seen: unknown[] = [];
		const bus: ExtensionAPI = {
			events: {
				emit(name: string, value: { payload: unknown; claimed: boolean; completion?: Promise<unknown> }) {
					assert.equal(name, PRAUTOPILOT_REQUEST_EVENT);
					seen.push(value.payload);
					value.claimed = true;
					value.completion = Promise.resolve({ status: "blocked" });
				},
			},
		} as never;
		const result = await dispatchRoute(
			"pr-autopilot",
			"",
			undefined,
			false,
			"generic",
			token,
			lifecycle,
			bus,
			{ cwd: "/repo" } as ExtensionCommandContext,
			{ route: "pr-autopilot", mode: "drive" },
		);
		assert.equal(result.status, "dispatched");
		assert.deepEqual(seen, [{ mode: "drive", prNumber: undefined, ctx: { cwd: "/repo" }, cwd: "/repo" }]);
	});

	it("dispatches land with the exact target, readiness, and method", async () => {
		const { lifecycle, token } = setup();
		const seen: unknown[] = [];
		const bus: ExtensionAPI = {
			events: {
				emit(name: string, value: { payload: unknown; claimed: boolean; completion?: Promise<unknown> }) {
					assert.equal(name, LAND_REQUEST_EVENT);
					seen.push(value.payload);
					value.claimed = true;
					value.completion = Promise.resolve({ status: "declined" });
				},
			},
		} as never;
		const result = await dispatchRoute(
			"land",
			"",
			undefined,
			false,
			"generic",
			token,
			lifecycle,
			bus,
			{ cwd: "/work" } as ExtensionCommandContext,
			{ route: "land", prNumber: 42, readiness: "watch", method: "squash" },
		);
		assert.equal(result.status, "dispatched");
		assert.deepEqual(seen, [
			{
				options: {
					target: { kind: "single", prNumber: 42 },
					readiness: "watch",
					method: "squash",
					cwd: "/work",
				},
				ctx: { cwd: "/work" },
			},
		]);
	});

	it("fails closed when a post-PR request is missing or mismatched", async () => {
		const { lifecycle, token } = setup();
		const emit = () => assert.fail("must not emit");
		const bus = { events: { emit } } as never;
		const missing = await dispatchRoute("pr-autopilot", "", undefined, false, "generic", token, lifecycle, bus, ctx);
		assert.equal(missing.status, "failed");
		const mismatched = await dispatchRoute("land", "", undefined, false, "generic", token, lifecycle, bus, ctx, {
			route: "pr-autopilot",
			mode: "check",
		});
		assert.equal(mismatched.status, "failed");
	});

	it("reports an unavailable post-PR handler", async () => {
		const { lifecycle, token } = setup();
		const bus = { events: { emit() {} } } as never;
		const result = await dispatchRoute(
			"pr-autopilot",
			"",
			undefined,
			false,
			"generic",
			token,
			lifecycle,
			bus,
			{ cwd: "/repo" } as ExtensionCommandContext,
			{ route: "pr-autopilot", mode: "check", prNumber: 3 },
		);
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /pr-autopilot extension is not loaded/);
	});
});
