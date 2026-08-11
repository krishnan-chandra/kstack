import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandoffHandler, type HandoffDeps, type HandoffLoader } from "./index.ts";
import { DEFAULT_HANDOFF_GOAL } from "./handoff-context.ts";

const SESSION_FILE = "/sessions/old.jsonl";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CWD = "/proj";

interface FakeCtxOptions {
	mode?: string;
	model?: { contextWindow: number } | undefined;
	messages?: unknown[];
	completeResult?: unknown;
	editorResult?: string | undefined;
	newSessionResult?: { cancelled: boolean };
	sessionFile?: string | undefined;
}

function makeFakeCtx(order: string[], opts: FakeCtxOptions = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const customMessages: Array<{ customType: string; content: string; display: boolean }> = [];
	const calls = {
		setEditorText: [] as string[],
		complete: [] as Array<{ systemPrompt: string; text: string }>,
		newSession: 0,
	};

	const messages = opts.messages ?? [{ role: "user", content: "hello", timestamp: 1 }];
	const completeResult =
		opts.completeResult ?? { stopReason: "stop", content: [{ type: "text", text: "GENERATED PROMPT" }] };

	const ctx: Record<string, unknown> = {
		mode: opts.mode ?? "tui",
		model: "model" in opts ? opts.model : { contextWindow: 100_000 },
		cwd: CWD,
		waitForIdle: async () => {
			order.push("waitForIdle");
		},
		sessionManager: {
			buildSessionContext: () => {
				order.push("buildSessionContext");
				return { messages };
			},
			getSessionFile: () => ("sessionFile" in opts ? opts.sessionFile : SESSION_FILE),
			getSessionId: () => SESSION_ID,
		},
		modelRegistry: {
			complete: async (_model: unknown, request: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }) => {
				order.push("complete");
				calls.complete.push({ systemPrompt: request.systemPrompt, text: request.messages[0].content[0].text });
				return completeResult;
			},
		},
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
			custom: (factory: (tui: null, theme: null, kb: null, done: (v: unknown) => void) => unknown) =>
				new Promise((resolve) => factory(null, null, null, resolve)),
			editor: async (_title: string, prefill?: string) => {
				order.push("editor");
				if ("editorResult" in opts) return opts.editorResult;
				return `EDITED ${prefill}`;
			},
			setEditorText: (text: string) => {
				order.push("old.setEditorText");
				calls.setEditorText.push(text);
			},
		},
		newSession: async (options: {
			parentSession?: string;
			setup?: (sm: unknown) => Promise<void>;
			withSession?: (fresh: unknown) => Promise<void>;
		}) => {
			order.push("newSession");
			calls.newSession++;
			assert.equal(options.parentSession, "sessionFile" in opts ? opts.sessionFile : SESSION_FILE);
			const sm = {
				appendCustomMessageEntry: (customType: string, content: string, display: boolean) => {
					customMessages.push({ customType, content, display });
					return "entry-id";
				},
			};
			await options.setup?.(sm);
			const fresh = {
				ui: {
					setEditorText: (text: string) => {
						order.push("fresh.setEditorText");
						calls.setEditorText.push(text);
					},
					notify: () => {},
				},
			};
			await options.withSession?.(fresh);
			return opts.newSessionResult ?? { cancelled: false };
		},
	};

	return { ctx, notifications, customMessages, calls };
}

function makeDeps(): HandoffDeps {
	return {
		convertToLlm: ((messages: unknown[]) => messages) as HandoffDeps["convertToLlm"],
		serializeConversation: ((messages: unknown[]) =>
			messages.map((m) => JSON.stringify(m)).join("\n")) as HandoffDeps["serializeConversation"],
		loaderFactory: (): HandoffLoader => ({
			signal: new AbortController().signal,
			onAbort: undefined,
		}),
		newCallId: () => "call-id",
	};
}

describe("handoff command guards", () => {
	it("rejects non-TUI mode", async () => {
		const order: string[] = [];
		const { ctx, notifications } = makeFakeCtx(order, { mode: "rpc" });
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.equal(notifications[0].message, "handoff requires interactive mode");
		assert.equal(notifications[0].level, "error");
		assert.deepEqual(order, []);
	});

	it("rejects when no model is selected", async () => {
		const order: string[] = [];
		const { ctx, notifications } = makeFakeCtx(order, { model: undefined });
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.equal(notifications[0].message, "No model selected");
		assert.deepEqual(order, []);
	});

	it("rejects an empty conversation without synthesis", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, { messages: [] });
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.equal(notifications[0].message, "No conversation to hand off");
		assert.equal(calls.complete.length, 0);
	});

	it("stops with a /compact recommendation when history exceeds the budget", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, { model: { contextWindow: 10 } });
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.ok(notifications[0].message.includes("/compact"));
		assert.equal(notifications[0].level, "error");
		assert.equal(calls.complete.length, 0);
	});
});

describe("handoff command lifecycle", () => {
	it("runs the full flow in order and uses only fresh UI after the switch", async () => {
		const order: string[] = [];
		const { ctx, calls, customMessages } = makeFakeCtx(order);
		await createHandoffHandler(makeDeps())("  implement teams support  ", ctx as never);

		assert.deepEqual(order, [
			"waitForIdle",
			"buildSessionContext",
			"complete",
			"editor",
			"newSession",
			"fresh.setEditorText",
		]);
		// The edited prompt lands in the new session's editor, never via the stale ctx,
		// and carries the exact provenance even though the fake model omitted it.
		assert.equal(calls.setEditorText.length, 1);
		assert.ok(calls.setEditorText[0].startsWith("EDITED GENERATED PROMPT"));
		assert.ok(calls.setEditorText[0].includes(SESSION_FILE));
		assert.ok(calls.setEditorText[0].includes(SESSION_ID));
		// Goal is trimmed and forwarded to the synthesis call.
		assert.ok(calls.complete[0].text.includes("implement teams support"));
		// The history custom message is appended in the new session.
		assert.equal(customMessages.length, 1);
		assert.equal(customMessages[0].customType, "handoff");
		assert.equal(customMessages[0].display, true);
		assert.ok(customMessages[0].content.includes(SESSION_FILE));
		assert.ok(customMessages[0].content.includes(SESSION_ID));
		assert.ok(customMessages[0].content.includes("search_session_archive"));
	});

	it("uses the default goal when no argument is given", async () => {
		const order: string[] = [];
		const { ctx, calls } = makeFakeCtx(order);
		await createHandoffHandler(makeDeps())("   ", ctx as never);
		assert.ok(calls.complete[0].text.includes(DEFAULT_HANDOFF_GOAL));
	});

	it("omits parentSession and marks the reference ephemeral for file-less sessions", async () => {
		const order: string[] = [];
		const { ctx, customMessages } = makeFakeCtx(order, { sessionFile: undefined });
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.ok(customMessages[0].content.includes("(ephemeral"));
	});

	it("notifies and stays in the old session when newSession is cancelled", async () => {
		const order: string[] = [];
		const { ctx, notifications } = makeFakeCtx(order, { newSessionResult: { cancelled: true } });
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		const last = notifications.at(-1)!;
		assert.equal(last.message, "New session cancelled");
		assert.equal(last.level, "info");
	});
});

describe("handoff abort paths", () => {
	it("creates no session when the model call is aborted", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			completeResult: { stopReason: "aborted", content: [] },
		});
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "Cancelled");
		assert.equal(calls.newSession, 0);
	});

	it("creates no session when the model errors", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			completeResult: { stopReason: "error", errorMessage: "provider blew up", content: [] },
		});
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.ok(notifications.at(-1)!.message.includes("provider blew up"));
		assert.equal(notifications.at(-1)!.level, "error");
		assert.equal(calls.newSession, 0);
	});

	it("creates no session when the editor is cancelled", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: undefined });
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "Cancelled");
		assert.equal(calls.newSession, 0);
	});

	it("treats an empty generated prompt as an error", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			completeResult: { stopReason: "stop", content: [{ type: "text", text: "   " }] },
		});
		await createHandoffHandler(makeDeps())("goal", ctx as never);
		assert.equal(notifications.at(-1)!.level, "error");
		assert.equal(calls.newSession, 0);
	});
});
