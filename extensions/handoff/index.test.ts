import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHandoffHandler } from "./index.ts";
import { DEFAULT_HANDOFF_GOAL } from "./handoff-context.ts";
import type { HandoffEffortLevel, HandoffModel } from "./model-selection.ts";

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
const ALL_EFFORTS: HandoffEffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface FakeApiOptions {
	setModelResult?: boolean;
	setModelError?: Error;
	thinkingLevel?: string;
	availableEfforts?: string[];
	setThinkingLevelError?: Error;
}

function makeFakeApi(order: string[], opts: FakeApiOptions = {}) {
	const available = opts.availableEfforts ?? ALL_EFFORTS;
	let thinkingLevel = opts.thinkingLevel ?? "";
	const calls = { setModel: [] as unknown[], setThinkingLevel: [] as string[] };
	const api = {
		setModel: async (model: unknown) => {
			order.push("setModel");
			calls.setModel.push(model);
			if (opts.setModelError) throw opts.setModelError;
			return opts.setModelResult ?? true;
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level: string) => {
			order.push("setThinkingLevel");
			calls.setThinkingLevel.push(level);
			if (opts.setThinkingLevelError) throw opts.setThinkingLevelError;
			thinkingLevel = available.includes(level) ? level : (available.at(-1) ?? "off");
		},
	};
	return { api, apiCalls: calls };
}

interface FakeCtxOptions {
	mode?: string;
	editorResult?: string | undefined;
	newSessionResult?: { cancelled: boolean };
	newSessionError?: Error;
	sendUserMessageError?: Error;
	sessionFile?: string | undefined;
	model?: HandoffModel | undefined;
	thinkingLevel?: string;
	scopedModels?: Array<{ model: HandoffModel }>;
	freshModel?: HandoffModel | undefined;
	freshThinkingLevel?: string;
	freshHasConfiguredAuth?: boolean;
	freshProviderAuth?: unknown;
}

function makeFakeCtx(order: string[], opts: FakeCtxOptions = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const customMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = [];
	const calls = {
		editorDrafts: [] as string[],
		sendUserMessage: [] as string[],
		setEditorText: [] as string[],
		sessionNames: [] as string[],
		newSession: 0,
	};

	const ctx: Record<string, unknown> = {
		mode: opts.mode ?? "tui",
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		cwd: CWD,
		modelRegistry: {
			getAll: () => MODELS,
		},
		scopedModels: opts.scopedModels ?? [],
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
		sendUserMessage: () => {
			throw new Error("stale sendUserMessage used after replacement");
		},
		newSession: async (options: {
			parentSession?: string;
			setup?: (sm: unknown) => Promise<void>;
			withSession?: (fresh: unknown) => Promise<void>;
		}) => {
			order.push("newSession");
			calls.newSession++;
			assert.equal(options.parentSession, SESSION_FILE);
			if (opts.newSessionError) throw opts.newSessionError;
			if (opts.newSessionResult?.cancelled) return opts.newSessionResult;

			await options.setup?.({
				appendSessionInfo: (name: string) => {
					calls.sessionNames.push(name);
					return "session-name-entry-id";
				},
				appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown) => {
					customMessages.push({ customType, content, display, details });
					return "entry-id";
				},
			});
			await options.withSession?.({
				model: "freshModel" in opts ? opts.freshModel : MODELS[0],
				thinkingLevel: "freshThinkingLevel" in opts ? opts.freshThinkingLevel : opts.thinkingLevel,
				modelRegistry: {
					hasConfiguredAuth: () => opts.freshHasConfiguredAuth ?? true,
					getProviderAuth: async () => opts.freshProviderAuth,
				},
				ui: {
					setEditorText: (text: string) => {
						order.push("fresh.setEditorText");
						calls.setEditorText.push(text);
					},
					notify: (message: string, level: string) => {
						notifications.push({ message, level });
					},
				},
				sendUserMessage: async (text: string) => {
					order.push("fresh.sendUserMessage");
					calls.sendUserMessage.push(text);
					if (opts.sendUserMessageError) throw opts.sendUserMessageError;
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
			"fresh.sendUserMessage",
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
		assert.deepEqual(calls.sendUserMessage, [`EDITED ${draft}`]);
		assert.deepEqual(calls.sessionNames, ["implement-teams-support"]);

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
		assert.deepEqual(calls.sessionNames, ["continue-implementation-from-the-previous"]);
	});

	it("names the replacement from an edited goal", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, calls } = makeFakeCtx(order, {
			editorResult: "Continue work.\n\n## Goal\nShip the corrected archive workflow.\n",
		});
		await createHandoffHandler(api)("old goal", ctx as never);
		assert.deepEqual(calls.sessionNames, ["ship-the-corrected-archive-workflow"]);
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
		assert.ok(!order.includes("fresh.sendUserMessage"));
	});

	it("leaves the prompt in the editor when the replacement session has no model", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { freshModel: undefined });
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.equal(calls.sendUserMessage.length, 0);
		assert.equal(calls.setEditorText.length, 1);
		assert.ok(!order.includes("fresh.sendUserMessage"));
		assert.ok(order.includes("fresh.setEditorText"));
		assert.equal(notifications.at(-1)!.level, "warning");
		assert.ok(notifications.at(-1)!.message.includes("ready to submit"));
		assert.ok(notifications.at(-1)!.message.includes("No model selected"));
	});

	it("leaves the prompt in the editor when the replacement session has no credentials", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { freshHasConfiguredAuth: false });
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(calls.sendUserMessage.length, 0);
		assert.equal(calls.setEditorText.length, 1);
		assert.equal(notifications.at(-1)!.level, "warning");
		assert.ok(notifications.at(-1)!.message.includes("No credentials available"));
	});

	it("does not restore a possibly accepted prompt when sendUserMessage throws", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			freshModel: MODELS[2],
			sendUserMessageError: new Error("provider failed after accepting prompt"),
		});

		await assert.rejects(
			createHandoffHandler(api)("--model openai/gpt-5.2:high goal", ctx as never),
			/provider failed after accepting prompt/,
		);
		assert.equal(calls.sendUserMessage.length, 1);
		assert.equal(calls.setEditorText.length, 0);
		assert.deepEqual(apiCalls.setModel, [MODELS[2]]);
		assert.deepEqual(apiCalls.setThinkingLevel, ["high"]);
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
			"fresh.sendUserMessage",
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
			"fresh.sendUserMessage",
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
			"fresh.sendUserMessage",
		]);
		const draft = calls.editorDrafts[0];
		assert.ok(draft.includes("## Goal\nship the feature"));
		assert.ok(!draft.includes("--model"));
		assert.ok(!draft.includes("gpt-5.2"));
	});

	it("does not leak an effort suffix into the goal draft", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, calls } = makeFakeCtx(order, { model: PARENT_MODEL, thinkingLevel: "medium" });
		await createHandoffHandler(api)("--model openai/gpt-5.2:high ship the feature", ctx as never);
		const draft = calls.editorDrafts[0];
		assert.ok(draft.includes("## Goal\nship the feature"));
		assert.ok(!draft.includes("--model"));
		assert.ok(!draft.includes("gpt-5.2"));
		assert.ok(!draft.includes(":high"));
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

describe("handoff model restoration on failed handoff", () => {
	it("restores the parent model when the replacement is cancelled after --model", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications, calls, customMessages } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);

		assert.deepEqual(apiCalls.setModel, [MODELS[2], PARENT_MODEL]);
		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"setModel",
			"newSession",
			"setModel",
		]);
		assert.equal(customMessages.length, 0);
		assert.equal(calls.newSession, 1);
		assert.equal(notifications.at(-1)!.message, "New session cancelled");
		assert.equal(notifications.at(-1)!.level, "info");
	});

	it("restores the parent model and effort when the replacement is cancelled after --model:effort", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, notifications } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2:high goal", ctx as never);

		assert.deepEqual(apiCalls.setModel, [MODELS[2], PARENT_MODEL]);
		assert.deepEqual(apiCalls.setThinkingLevel, ["high", "medium"]);
		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"setModel",
			"setThinkingLevel",
			"newSession",
			"setModel",
			"setThinkingLevel",
		]);
		assert.equal(notifications.at(-1)!.message, "New session cancelled");
	});

	it("restores the parent model when newSession throws and rethrows the error", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			newSessionError: new Error("runtime creation failed"),
		});
		await assert.rejects(
			createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never),
			/runtime creation failed/,
		);
		assert.deepEqual(apiCalls.setModel, [MODELS[2], PARENT_MODEL]);
		assert.equal(calls.newSession, 1);
	});

	it("restores the parent model and effort when newSession throws after an effort switch", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "low" });
		const { ctx, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			newSessionError: new Error("runtime creation failed"),
		});
		await assert.rejects(
			createHandoffHandler(api)("--model openai/gpt-5.2:max goal", ctx as never),
			/runtime creation failed/,
		);
		assert.deepEqual(apiCalls.setModel, [MODELS[2], PARENT_MODEL]);
		assert.deepEqual(apiCalls.setThinkingLevel, ["max", "low"]);
		assert.equal(calls.newSession, 1);
	});

	it("does not restore when cancelled without an explicit --model", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler(api)("goal", ctx as never);
		// The inherit pin sets the parent's own model; there is no switch to undo.
		assert.deepEqual(apiCalls.setModel, [PARENT_MODEL]);
		assert.equal(notifications.at(-1)!.message, "New session cancelled");
	});

	it("notes the kept model when cancelled with --model but no previous model", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications } = makeFakeCtx(order, {
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);
		assert.deepEqual(apiCalls.setModel, [MODELS[2]]);
		assert.equal(notifications.at(-1)!.message, "New session cancelled; the parent session keeps openai/gpt-5.2");
	});

	it("notes the kept model and effort when cancelled with no previous model", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications } = makeFakeCtx(order, {
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2:high goal", ctx as never);
		assert.deepEqual(apiCalls.setModel, [MODELS[2]]);
		assert.deepEqual(apiCalls.setThinkingLevel, ["high"]);
		assert.equal(
			notifications.at(-1)!.message,
			"New session cancelled; the parent session keeps openai/gpt-5.2:high",
		);
	});
});

describe("handoff effort selection", () => {
	it("inherits the parent effort when --model has no suffix", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "high" });
		const { ctx, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "high",
			freshModel: MODELS[2],
			freshThinkingLevel: "high",
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2 ship the feature", ctx as never);

		assert.deepEqual(apiCalls.setModel, [MODELS[2]]);
		assert.ok(apiCalls.setThinkingLevel.includes("high"));
		assert.ok(order.indexOf("setModel") < order.indexOf("setThinkingLevel"));
		assert.ok(order.indexOf("setThinkingLevel") < order.indexOf("newSession"));
		assert.equal(calls.newSession, 1);
	});

	it("inherits the parent model and effort when --model is omitted", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			freshModel: PARENT_MODEL,
			freshThinkingLevel: "medium",
		});
		await createHandoffHandler(api)("goal", ctx as never);

		assert.deepEqual(apiCalls.setModel, [PARENT_MODEL]);
		assert.ok(apiCalls.setThinkingLevel.includes("medium"));
		assert.ok(order.indexOf("setModel") < order.indexOf("setThinkingLevel"));
		assert.ok(order.indexOf("setThinkingLevel") < order.indexOf("newSession"));
		assert.equal(calls.newSession, 1);
		assert.ok(notifications.some((n) => n.level === "info" && n.message.includes("Model: anthropic/claude-opus-4-6:medium")));
	});

	it("sets an explicit effort after the model and before newSession", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "low" });
		const { ctx, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[2],
			freshThinkingLevel: "max",
		});
		await createHandoffHandler(api)("-m anthropic/claude-opus-4-6:max finish the refactor", ctx as never);

		assert.deepEqual(apiCalls.setModel, [PARENT_MODEL]);
		assert.deepEqual(apiCalls.setThinkingLevel, ["max"]);
		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"setModel",
			"setThinkingLevel",
			"newSession",
			"fresh.sendUserMessage",
		]);
		assert.equal(calls.newSession, 1);
	});

	it("pins an already-current inherited effort so a fresh session can inherit it", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "high" });
		const { ctx } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "high",
			freshModel: PARENT_MODEL,
			freshThinkingLevel: "high",
		});
		await createHandoffHandler(api)("goal", ctx as never);
		assert.deepEqual(apiCalls.setThinkingLevel, ["high", "off", "high"]);
	});

	it("warns when an explicit effort is clamped to a supported level", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, {
			thinkingLevel: "medium",
			availableEfforts: ["low", "medium", "high"],
		});
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			freshModel: MODELS[2],
			freshThinkingLevel: "high",
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2:max goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.deepEqual(apiCalls.setThinkingLevel, ["max"]);
		assert.ok(
			notifications.some(
				(n) => n.level === "warning" && n.message.includes("Requested effort max is not supported; using high instead"),
			),
		);
	});

	it("falls back to getThinkingLevel when ctx.thinkingLevel is missing", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "xhigh" });
		const { ctx } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			freshModel: PARENT_MODEL,
			freshThinkingLevel: "xhigh",
		});
		await createHandoffHandler(api)("goal", ctx as never);
		assert.ok(apiCalls.setThinkingLevel.includes("xhigh"));
	});

	it("restores model and effort when setting effort throws", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, {
			thinkingLevel: "medium",
			setThinkingLevelError: new Error("settings locked"),
		});
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2:high goal", ctx as never);
		assert.equal(calls.newSession, 0);
		assert.deepEqual(apiCalls.setModel, [MODELS[2], PARENT_MODEL]);
		assert.deepEqual(apiCalls.setThinkingLevel, ["high", "medium"]);
		assert.ok(notifications.some((n) => n.level === "error" && n.message.includes("Could not set effort high")));
	});
});

describe("handoff model scoping and override detection", () => {
	const SCOPED = [{ model: MODELS[2] }, { model: MODELS[3] }];

	it("restricts --model to scoped models when scoping is active", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { scopedModels: SCOPED });
		await createHandoffHandler(api)("--model anthropic/claude-sonnet-4-5 goal", ctx as never);
		assert.equal(calls.newSession, 0);
		assert.equal(apiCalls.setModel.length, 0);
		assert.deepEqual(order, []);
		assert.equal(notifications[0].level, "error");
		assert.ok(notifications[0].message.includes('Unknown model "anthropic/claude-sonnet-4-5"'));
		assert.ok(notifications[0].message.includes("scoping"));
	});

	it("accepts a scoped model when scoping is active", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, calls } = makeFakeCtx(order, { scopedModels: SCOPED });
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.deepEqual(apiCalls.setModel, [MODELS[2]]);
	});

	it("warns when the replacement session started on a different model than requested", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			freshModel: MODELS[0],
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.equal(notifications.at(-1)!.level, "warning");
		assert.ok(notifications.at(-1)!.message.includes("is on anthropic/claude-sonnet-4-5"));
		assert.ok(notifications.at(-1)!.message.includes("instead of openai/gpt-5.2"));
	});

	it("reports the requested model when the replacement session matches it", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { freshModel: MODELS[2] });
		await createHandoffHandler(api)("--model openai/gpt-5.2 goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.equal(notifications.at(-1)!.level, "info");
		assert.ok(notifications.at(-1)!.message.includes("Model: openai/gpt-5.2"));
	});

	it("reports the replacement model and effort when both match", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			thinkingLevel: "medium",
			freshModel: MODELS[2],
			freshThinkingLevel: "high",
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2:high goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.equal(notifications.at(-1)!.level, "info");
		assert.ok(notifications.at(-1)!.message.includes("Model: openai/gpt-5.2:high"));
	});

	it("warns when the replacement session started on a different effort than requested", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			freshModel: MODELS[2],
			freshThinkingLevel: "low",
		});
		await createHandoffHandler(api)("--model openai/gpt-5.2:high goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.equal(notifications.at(-1)!.level, "warning");
		assert.ok(notifications.at(-1)!.message.includes("is on openai/gpt-5.2:low"));
		assert.ok(notifications.at(-1)!.message.includes("instead of openai/gpt-5.2:high"));
	});

	it("warns when inheritance fell back to a different model", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			freshModel: MODELS[2],
		});
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.equal(notifications.at(-1)!.level, "warning");
		assert.ok(notifications.at(-1)!.message.includes("is on openai/gpt-5.2"));
		assert.ok(notifications.at(-1)!.message.includes("instead of anthropic/claude-opus-4-6"));
		assert.ok(notifications.at(-1)!.message.includes("overrides inheritance"));
	});

	it("notifies when pinning the parent model fails but still hands off", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { setModelResult: false });
		const { ctx, notifications, calls } = makeFakeCtx(order, { model: PARENT_MODEL });
		await createHandoffHandler(api)("goal", ctx as never);
		assert.equal(calls.newSession, 1);
		assert.ok(
			notifications.some(
				(n) => n.level === "warning" && n.message.includes("Could not pin anthropic/claude-opus-4-6"),
			),
		);
	});
});
