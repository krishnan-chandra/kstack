import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoundaryValue } from "../shared/validation.ts";
import openrouterFloor from "./index.ts";
import { ROUTE_ENTRY_TYPE } from "./session-route.ts";

type Handler = (event: BoundaryValue, ctx: ExtensionContext) => BoundaryValue;
it("wires routing commands, reload, tree navigation, model selection and invalid config fallback", async () => {
	const directory = mkdtempSync(join(tmpdir(), "openrouter-adapter-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const configPath = join(directory, "kstack.json");
		writeFileSync(configPath, JSON.stringify({ "openrouter-floor": { default: "nitro" } }));
		const handlers = new Map<string, Handler>();
		const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
		const entries: unknown[] = [];
		const notices: string[] = [];
		const statuses: (string | undefined)[] = [];
		const host = {
			on(name: string, handler: Handler) {
				handlers.set(name, handler);
				return () => {};
			},
			registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
				commands.set(name, command);
			},
			appendEntry(customType: string, data: BoundaryValue) {
				entries.push({ type: "custom", customType, data });
			},
		};
		const context = {
			cwd: directory,
			mode: "tui",
			hasUI: true,
			model: { provider: "openrouter", id: "author/model" },
			sessionManager: { getBranch: () => entries },
			ui: {
				notify: (text: string) => notices.push(text),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			},
		};
		// SAFETY: The fixtures supply the Pi capabilities exercised by these adapter paths.
		const ctx = context as never;
		// SAFETY: The fixture implements every API used by registration and route commands.
		openrouterFloor(host as ExtensionAPI);
		const emit = async (name: string) => {
			const handler = handlers.get(name);
			assert.ok(handler, name);
			await handler({}, ctx);
		};
		await emit("session_start");
		assert.equal(statuses.at(-1), "OR nitro");
		const requestHandler = handlers.get("before_provider_request");
		assert.ok(requestHandler);
		const request = () => requestHandler({ payload: { model: "author/model" } }, ctx);
		assert.deepEqual(await request(), { model: "author/model:nitro" });
		const route = commands.get("openrouter-route");
		assert.ok(route);
		const completions = await route.getArgumentCompletions?.("n");
		assert.deepEqual(
			completions?.map((item) => item.value),
			["nitro", "none"],
		);
		await route.handler("none", ctx);
		assert.deepEqual(entries.at(-1), {
			type: "custom",
			customType: ROUTE_ENTRY_TYPE,
			data: { version: 1, override: "none" },
		});
		assert.equal(statuses.at(-1), "OR none (session)");
		assert.equal(await request(), undefined);
		await emit("session_start");
		assert.equal(statuses.at(-1), "OR none (session)");
		entries.length = 0;
		await emit("session_tree");
		assert.equal(statuses.at(-1), "OR nitro");
		await route.handler("floor", ctx);
		assert.deepEqual(await request(), { model: "author/model:floor" });
		await route.handler("reset", ctx);
		assert.equal(statuses.at(-1), "OR nitro");
		assert.deepEqual(entries.at(-1), {
			type: "custom",
			customType: ROUTE_ENTRY_TYPE,
			data: { version: 1, override: null },
		});
		await route.handler("bad", ctx);
		assert.match(notices.at(-1) ?? "", /Usage:/);
		context.mode = "rpc";
		statuses.length = 0;
		await emit("model_select");
		assert.equal(statuses.at(-1), "OR nitro", "RPC clients receive route status");
		context.model = { provider: "openai", id: "direct" };
		await emit("model_select");
		assert.equal(statuses.at(-1), undefined);
		await route.handler("", ctx);
		assert.match(notices.at(-1) ?? "", /once an OpenRouter model/);
		context.model = { provider: "openrouter", id: "author/model" };
		writeFileSync(configPath, JSON.stringify({ "openrouter-floor": { default: "invalid" } }));
		await emit("session_start");
		await emit("session_start");
		assert.equal(statuses.at(-1), "OR floor");
		assert.equal(notices.filter((notice) => notice.includes("using :floor")).length, 1);
		await route.handler("", ctx);
		assert.match(notices.at(-1) ?? "", /Config invalid:.*openrouter-floor.default/);
		writeFileSync(configPath, JSON.stringify({ "openrouter-floor": { default: "nitro" } }));
		await emit("session_start");
		await route.handler("", ctx);
		assert.doesNotMatch(notices.at(-1) ?? "", /Config invalid/);
		await emit("session_shutdown");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
