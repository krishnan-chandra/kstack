import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandoffHandler } from "./index.ts";
import { DEFAULT_HANDOFF_GOAL } from "./handoff-context.ts";
import type { HandoffModel } from "./model-selection.ts";

const SESSION_FILE = "/sessions/old.jsonl";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CWD = "/proj";

const MODELS: HandoffModel[] = [
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
	{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
	{ provider: "openai", id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
];

const PARENT_MODEL: HandoffModel = { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" };

interface FakeApiOptions {
	setModelResult?: boolean;
	setModelError?: Error;
}

function makeFakeApi(order: string[], opts: FakeApiOptions = {}) {
	const calls = { setModel: [] as unknown[] };
	const api = {
		setModel: async (model: unknown) => {
			order.push("setModel");
			calls.setModel.push(model);
			if (opts.setModelError) throw opts.setModelError;
			return opts.setModelResult ?? true;
		},
	};
	return { api, apiCalls: calls };
}

interface FakeCtxOptions {
	mode?: string;
	editorResult?: string | undefined;
	newSessionResult?: { cancelled: boolean };
	sessionFile?: string | undefined;
	model?: HandoffModel | undefined;
}

function makeFakeCtx(order: string[], opts: FakeCtxOptions = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const customMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
	const calls = {
		editorDrafts: [] as string[],
		setEditorText: [] as string[],
		newSession: 0,
	};

	const ctx: Record<string, unknown> = {
		mode: opts.mode ?? "tui",
		model: opts.model,
		cwd: CWD,
		modelRegistry: {
			getAll: () => MODELS,
		},
		waitForIdle: async () => {
			order.push("waitForIdle");
		},
		sessionManager: {
			getSessionFile: () => {
				order.push("getSessionFile");
				return "sessionFile" in opts ? opts.sessionFile : SESSION_FILE;
			},
			getSessionId: () => {
				order.push("getSessionId");
				return SESSION_ID;
			},
		},
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
			editor: async (_title: string, prefill: string) => {
				order.push("editor");
				calls.editorDrafts.push(prefill);
				if ("editorResult" in opts) return opts.editorResult;
				return `EDITED ${prefill}`;
			},
			setEditorText: () => {
				throw new Error("stale UI used after replacement");
			},
		},
		newSession: async (options: {
			parentSession?: string;
			setup?: (sm: unknown) => Promise<void>;
			withSession?: (fresh: unknown) => Promise<void>;
		}) => {
			order.push("newSession");
			calls.newSession++;
			assert.equal(options.parentSession, SESSION_FILE);
			if (opts.newSessionResult?.cancelled) return opts.newSessionResult;

			await options.setup?.({
				appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown) => {
					customMessages.push({ customType, content, display, details });
					return "entry-id";
				},
			});
			await options.withSession?.({
				ui: {
					setEditorText: (text: string) => {
						order.push("fresh.setEditorText");
						calls.setEditorText.push(text);
					},
					notify: (message: string, level: string) => {
						notifications.push({ message, level });
					},
				},
			});
			return { cancelled: false };
		},
	};

	return { ctx, notifications, customMessages, calls };
}

describe("handoff command guards", () => {
	it("rejects non-TUI mode", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications } = makeFakeCtx(order, { mode: "rpc" });
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(notifications[0].message, "handoff requires interactive mode");
		assert.equal(notifications[0].level, "error");
		assert.deepEqual(order, []);
	});

	it("rejects an ephemeral source because there is no durable history reference", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { sessionFile: undefined });
		await createHandoffHandler(api)("goal", ctx as never);
		assert.deepEqual(order, ["waitForIdle", "getSessionFile"]);
		assert.ok(notifications[0].message.includes("persisted session"));
		assert.ok(notifications[0].message.includes("--no-session"));
		assert.equal(calls.newSession, 0);
	});
});

describe("handoff command lifecycle", () => {
	it("creates a reference-only handoff without requiring a model or reading conversation context", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, calls, customMessages } = makeFakeCtx(order);
		await createHandoffHandler(api)("  implement teams support  ", ctx as never);

		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"newSession",
			"fresh.setEditorText",
		]);
		assert.equal(apiCalls.setModel.length, 0);
		assert.equal(calls.editorDrafts.length, 1);
		const draft = calls.editorDrafts[0];
		assert.ok(draft.includes("## Goal\nimplement teams support"));
		assert.ok(draft.includes(SESSION_FILE));
		assert.ok(draft.includes(SESSION_ID));
		assert.ok(draft.includes("read_handoff_history"));
		assert.ok(draft.includes("search_handoff_history"));
		assert.ok(!draft.includes("## Conversation History"));
		assert.deepEqual(calls.setEditorText, [`EDITED ${draft}`]);

		assert.equal(customMessages.length, 1);
		assert.equal(customMessages[0].customType, "handoff");
		assert.equal(customMessages[0].display, true);
		assert.ok(customMessages[0].content.includes(SESSION_FILE));
		assert.ok(customMessages[0].content.includes(SESSION_ID));
		assert.ok(customMessages[0].content.includes("read_session_archive"));
		assert.deepEqual(customMessages[0].details, {
			version: 1,
			sessionFile: SESSION_FILE,
			sessionId: SESSION_ID,
			cwd: CWD,
		});
	});

	it("uses the default goal when no argument is given", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, calls } = makeFakeCtx(order);
		await createHandoffHandler(api)("   ", ctx as never);
		assert.ok(calls.editorDrafts[0].includes(DEFAULT_HANDOFF_GOAL));
	});

	it("notifies and stays in the old session when replacement is cancelled", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, customMessages } = makeFakeCtx(order, {
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "New session cancelled");
		assert.equal(notifications.at(-1)!.level, "info");
		assert.equal(customMessages.length, 0);
		assert.ok(!order.includes("fresh.setEditorText"));
	});
});

describe("handoff editor cancellation", () => {
	it("creates no session when the editor is cancelled", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: undefined });
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "Cancelled");
		assert.equal(calls.newSession, 0);
	});

	it("creates no session when the edited prompt is empty", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: "  \n" });
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "Handoff prompt cannot be empty");
		assert.equal(notifications.at(-1)!.level, "error");
		assert.equal(calls.newSession, 0);
	});
});

describe("handoff model selection", () => {
	it("inherits the parent session's model by default", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, calls } = makeFakeCtx(order, { model: PARENT_MODEL });
		await createHandoffHandler(api)("goal", ctx as never);

		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"setModel",
			"newSession",
			"fresh.setEditorText",
		]);
		assert.deepEqual(apiCalls.setModel, [PARENT_MODEL]);
		assert.equal(calls.newSession, 1);
	});

	it("still hands off when inheriting the model fails", async () => {
		const order: string[] = [];
		const failing = {
			setModel: async () => {
				order.push("setModel");
				throw new Error("settings unavailable");
			},
		};
		const { ctx, calls } = makeFakeCtx(order, { model: PARENT_MODEL });
		await createHandoffHandler(failing)("goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"setModel",
			"newSession",
			"fresh.setEditorText",
		]);
	});

	it("switches to an explicit model before creating the replacement session", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, calls } = makeFakeCtx(order, { model: PARENT_MODEL });
		await createHandoffHandler(api)("--model openai/gpt-5.2 ship the feature", ctx as never);

		assert.deepEqual(apiCalls.setModel, [MODELS[2]]);
		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"setModel",
			"newSession",
			"fresh.setEditorText",
		]);
		const draft = calls.editorDrafts[0];
		assert.ok(draft.includes("## Goal\nship the feature"));
		assert.ok(!draft.includes("--model"));
		assert.ok(!draft.includes("gpt-5.2"));
	});

	it("accepts -m, --model=, and unique bare model ids", async () => {
		for (const args of ["-m gpt-5.2 goal", "--model=openai/gpt-5.2-codex goal", "--model gpt-5.2-codex goal"]) {
			const order: string[] = [];
			const { api, apiCalls } = makeFakeApi(order);
			const { ctx, calls } = makeFakeCtx(order);
			await createHandoffHandler(api)(args, ctx as never);
			assert.equal(calls.newSession, 1, `no session created for: ${args}`);
			assert.equal(apiCalls.setModel.length, 1, `setModel not called for: ${args}`);
			assert.equal((apiCalls.setModel[0] as HandoffModel).provider, "openai");
		}
	});

	it("rejects an unknown model before opening the editor", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order);
		await createHandoffHandler(api)("--model nope/does-not-exist goal", ctx as never);
		assert.equal(calls.newSession, 0);
		assert.equal(apiCalls.setModel.length, 0);
		assert.deepEqual(order, []);
		assert.equal(notifications[0].level, "error");
		assert.ok(notifications[0].message.includes('Unknown model "nope/does-not-exist"'));
	});

	it("rejects an ambiguous model reference with the matches", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order);
		await createHandoffHandler(api)("--model gpt goal", ctx as never);
		assert.equal(calls.newSession, 0);
		assert.equal(apiCalls.setModel.length, 0);
		assert.equal(notifications[0].level, "error");
		assert.ok(notifications[0].message.includes("ambiguous"));
		assert.ok(notifications[0].message.includes("openai/gpt-5.2"));
		assert.ok(notifications[0].message.includes("openai/gpt-5.2-codex"));
	});

	it("rejects a --model flag with no value", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order);
		await createHandoffHandler(api)("goal --model", ctx as never);
		assert.equal(calls.newSession, 0);
		assert.deepEqual(order, []);
		assert.equal(notifications[0].level, "error");
		assert.ok(notifications[0].message.includes("--model requires a value"));
	});

	it("cancels the handoff when the requested model has no API key", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { setModelResult: false });
		const { ctx, notifications, calls } = makeFakeCtx(order);
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);
		assert.equal(apiCalls.setModel.length, 1);
		assert.equal(calls.newSession, 0);
		assert.equal(notifications.at(-1)!.level, "error");
		assert.ok(notifications.at(-1)!.message.includes("No API key available for openai/gpt-5.2"));
	});

	it("cancels the handoff when switching to the requested model throws", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { setModelError: new Error("auth store locked") });
		const { ctx, notifications, calls } = makeFakeCtx(order);
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);
		assert.equal(calls.newSession, 0);
		assert.equal(notifications.at(-1)!.level, "error");
		assert.ok(notifications.at(-1)!.message.includes("Could not switch to openai/gpt-5.2"));
		assert.ok(notifications.at(-1)!.message.includes("auth store locked"));
	});

	it("does not change the model when the editor is cancelled", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: undefined });
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);
		assert.equal(apiCalls.setModel.length, 0);
		assert.equal(calls.newSession, 0);
		assert.equal(notifications.at(-1)!.message, "Cancelled");
	});
});
