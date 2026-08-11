import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandoffHandler } from "./index.ts";
import { DEFAULT_HANDOFF_GOAL } from "./handoff-context.ts";

const SESSION_FILE = "/sessions/old.jsonl";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CWD = "/proj";

interface FakeCtxOptions {
	mode?: string;
	editorResult?: string | undefined;
	newSessionResult?: { cancelled: boolean };
	sessionFile?: string | undefined;
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
		model: undefined,
		cwd: CWD,
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
					notify: () => {},
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
		const { ctx, notifications } = makeFakeCtx(order, { mode: "rpc" });
		await createHandoffHandler()("goal", ctx as never);
		assert.equal(notifications[0].message, "handoff requires interactive mode");
		assert.equal(notifications[0].level, "error");
		assert.deepEqual(order, []);
	});

	it("rejects an ephemeral source because there is no durable history reference", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, { sessionFile: undefined });
		await createHandoffHandler()("goal", ctx as never);
		assert.deepEqual(order, ["waitForIdle", "getSessionFile"]);
		assert.ok(notifications[0].message.includes("persisted session"));
		assert.ok(notifications[0].message.includes("--no-session"));
		assert.equal(calls.newSession, 0);
	});
});

describe("handoff command lifecycle", () => {
	it("creates a reference-only handoff without requiring a model or reading conversation context", async () => {
		const order: string[] = [];
		const { ctx, calls, customMessages } = makeFakeCtx(order);
		await createHandoffHandler()("  implement teams support  ", ctx as never);

		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"newSession",
			"fresh.setEditorText",
		]);
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
		const { ctx, calls } = makeFakeCtx(order);
		await createHandoffHandler()("   ", ctx as never);
		assert.ok(calls.editorDrafts[0].includes(DEFAULT_HANDOFF_GOAL));
	});

	it("notifies and stays in the old session when replacement is cancelled", async () => {
		const order: string[] = [];
		const { ctx, notifications, customMessages } = makeFakeCtx(order, {
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler()("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "New session cancelled");
		assert.equal(notifications.at(-1)!.level, "info");
		assert.equal(customMessages.length, 0);
		assert.ok(!order.includes("fresh.setEditorText"));
	});
});

describe("handoff editor cancellation", () => {
	it("creates no session when the editor is cancelled", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: undefined });
		await createHandoffHandler()("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "Cancelled");
		assert.equal(calls.newSession, 0);
	});

	it("creates no session when the edited prompt is empty", async () => {
		const order: string[] = [];
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: "  \n" });
		await createHandoffHandler()("goal", ctx as never);
		assert.equal(notifications.at(-1)!.message, "Handoff prompt cannot be empty");
		assert.equal(notifications.at(-1)!.level, "error");
		assert.equal(calls.newSession, 0);
	});
});
