import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { archiveDestination } from "../session-archive/archive-files.ts";
import { makeTempTree, messageEntry, sessionJsonl, userMessage } from "../session-archive/test-helpers.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { createHandoffHandler as createHandler } from "./command.ts";
import { DEFAULT_HANDOFF_GOAL } from "./handoff-context.ts";
import { type HandoffSource, preflightHandoffHistory } from "./history-reader.ts";
import type { HandoffEffortLevel, HandoffModel } from "./model-selection.ts";
import type { ReplacementSelectionApi } from "./replacement-selection-api.ts";

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

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function withAgentDir(agentDir: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run();
	} finally {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	}
}

function writeArchiveSource(tree: ReturnType<typeof makeTempTree>): string {
	return tree.writeSession(
		SESSION_ID,
		sessionJsonl([messageEntry("u1", null, userMessage("source history"))], { id: SESSION_ID, cwd: CWD }),
	);
}

function writeOversizedArchiveSource(tree: ReturnType<typeof makeTempTree>): string {
	const sessionFile = tree.writeSession(SESSION_ID, sessionJsonl([], { id: SESSION_ID, cwd: CWD }));
	appendFileSync(
		sessionFile,
		'{"type":"custom_message","id":"x1","parentId":null,"timestamp":"2026-08-11T08:49:00.000Z","customType":"fixture","content":"',
	);
	const chunk = "x".repeat(1024 * 1024);
	for (let i = 0; i < 65; i++) appendFileSync(sessionFile, chunk);
	appendFileSync(sessionFile, '","display":true}\n');
	return sessionFile;
}

function createHandoffHandler(
	api: Parameters<typeof createHandler>[0],
	replacementApi?: ReplacementSelectionApi | undefined,
) {
	return createHandler(api, {
		preflightHistory: () => ({ kind: "ready" }),
		getReplacementApi: () => replacementApi,
	});
}

// The predecessor session's extension API. The handler must only read the
// parent thinking level from it; the spies prove the predecessor is never
// mutated.
function makeFakeApi(order: string[], opts: { thinkingLevel?: string } = {}) {
	const thinkingLevel = opts.thinkingLevel ?? "";
	const calls = {
		setModel: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as unknown[],
		setThinkingLevel:
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as string[],
	};
	const api = {
		setModel: async (model: BoundaryValue) => {
			order.push("setModel");
			calls.setModel.push(model);
			return true;
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level: string) => {
			order.push("setThinkingLevel");
			calls.setThinkingLevel.push(level);
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
	freshProviderAuth?: BoundaryValue;
	replacementSetModelResult?: boolean;
	replacementSetModelError?: Error;
	replacementAvailableEfforts?: string[];
	onEditor?: (prefill: string) => string | undefined;
	sessionDir?: string;
	sessionName?: string;
	expectedParentSession?: string | undefined;
	beforeWithSession?: () => void | Promise<void>;
}

function makeFakeCtx(order: string[], opts: FakeCtxOptions = {}) {
	const notifications: Array<{ message: string; level: string }> = [];
	const customMessages: Array<{ customType: string; content: string; display: boolean; details?: BoundaryValue }> = [];
	const calls = {
		editorDrafts: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as string[],
		sendUserMessage:
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as string[],
		setEditorText:
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as string[],
		oldSetEditorText:
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as string[],
		sessionNames: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as string[],
		newSession: 0,
	};
	let replacementStarted = false;

	// Live replacement-session state, mutated only through the replacement API
	// the way Pi's own setModel/setThinkingLevel mutate the active runtime.
	let freshModel = "freshModel" in opts ? opts.freshModel : MODELS[0];
	let freshThinkingLevel = "freshThinkingLevel" in opts ? opts.freshThinkingLevel : opts.thinkingLevel;
	const availableEfforts = opts.replacementAvailableEfforts ?? ALL_EFFORTS;
	const replacementCalls = {
		setModel:
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as HandoffModel[],
		setThinkingLevel:
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ [] as string[],
	};
	const replacementApi: ReplacementSelectionApi = {
		setModel: async (model: HandoffModel) => {
			order.push("replacement.setModel");
			replacementCalls.setModel.push(model);
			if (opts.replacementSetModelError) throw opts.replacementSetModelError;
			if (opts.replacementSetModelResult === false) return false;
			freshModel = model;
			return true;
		},
		setThinkingLevel: (level: string) => {
			order.push("replacement.setThinkingLevel");
			replacementCalls.setThinkingLevel.push(level);
			freshThinkingLevel = availableEfforts.includes(level) ? level : (availableEfforts.at(-1) ?? "off");
		},
	};

	const ctx = {
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
			getSessionDir: () => opts.sessionDir ?? "/sessions",
			getSessionName: () => opts.sessionName,
		},
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
			editor: async (_title: string, prefill: string) => {
				order.push("editor");
				calls.editorDrafts.push(prefill);
				if (opts.onEditor) return opts.onEditor(prefill);
				if ("editorResult" in opts) return opts.editorResult;
				return `EDITED ${prefill}`;
			},
			setEditorText: (text: string) => {
				if (replacementStarted) throw new Error("stale UI used after replacement");
				order.push("old.setEditorText");
				calls.oldSetEditorText.push(text);
			},
			confirm: async () => true,
		},
		sendUserMessage: () => {
			throw new Error("stale sendUserMessage used after replacement");
		},
		newSession: async (options: {
			parentSession?: string;
			setup?: (sm: BoundaryValue) => Promise<void>;
			withSession?: (fresh: BoundaryValue) => Promise<void>;
		}) => {
			order.push("newSession");
			calls.newSession++;
			replacementStarted = true;
			let expectedParent: string | undefined = SESSION_FILE;
			if ("expectedParentSession" in opts) {
				expectedParent = opts.expectedParentSession;
			} else if ("sessionFile" in opts) {
				expectedParent = opts.sessionFile;
			}
			assert.equal(options.parentSession, expectedParent);
			if (opts.newSessionError) throw opts.newSessionError;
			if (opts.newSessionResult?.cancelled) return opts.newSessionResult;

			await options.setup?.({
				appendSessionInfo: (name: string) => {
					calls.sessionNames.push(name);
					return "session-name-entry-id";
				},
				appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: BoundaryValue) => {
					customMessages.push({ customType, content, display, details });
					return "entry-id";
				},
			});
			const fresh = {
				get model() {
					return freshModel;
				},
				get thinkingLevel() {
					return freshThinkingLevel;
				},
				sessionManager: { getSessionFile: () => SESSION_FILE, getSessionId: () => SESSION_ID },
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
			};
			await opts.beforeWithSession?.();
			await options.withSession?.(fresh);
			return { cancelled: false };
		},
	};

	return { ctx, notifications, customMessages, calls, replacementApi, replacementCalls };
}

describe("handoff command guards", () => {
	it("rejects non-TUI mode", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications } = makeFakeCtx(order, { mode: "rpc" });
		await createHandoffHandler(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(notifications[0].message, "handoff requires interactive mode");
		assert.equal(notifications[0].level, "error");
		assert.deepEqual(order, []);
	});

	it("rejects an ephemeral source because there is no durable history reference", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { sessionFile: undefined });
		await createHandoffHandler(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.deepEqual(order, ["waitForIdle", "getSessionFile"]);
		assert.ok(notifications[0].message.includes("persisted session"));
		assert.ok(notifications[0].message.includes("--no-session"));
		assert.equal(calls.newSession, 0);
	});

	it("preflight rejects an unsupported default source before opening the editor", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const customFile = join(tree.root, "custom-session.jsonl");
		writeFileSync(customFile, sessionJsonl([], { id: SESSION_ID, cwd: CWD }));
		const env = { ...process.env, PI_CODING_AGENT_DIR: tree.agentDir };
		const preflightHistory = (source: HandoffSource) => preflightHandoffHistory(source, env);
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, notifications, calls, replacementCalls } = makeFakeCtx(order, { sessionFile: customFile });
		await createHandler(api, { preflightHistory })(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.match(notifications[0].message, /outside Pi's active session directory/i);
		assert.equal(calls.editorDrafts.length, 0);
		assert.equal(calls.newSession, 0);
		assert.equal(calls.sendUserMessage.length, 0);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.equal(replacementCalls.setModel.length, 0);
		assert.equal(replacementCalls.setThinkingLevel.length, 0);
	});

	it("preflight retains the edited prompt when history becomes unreadable", async () => {
		for (const change of ["delete", "replace"] as const) {
			const tree = makeTempTree();
			roots.push(tree.root);
			const sessionFile = tree.writeSession(
				SESSION_ID,
				sessionJsonl([messageEntry("u1", null, userMessage("source history"))], { id: SESSION_ID, cwd: CWD }),
			);
			const env = { ...process.env, PI_CODING_AGENT_DIR: tree.agentDir };
			const preflightHistory = (source: HandoffSource) => preflightHandoffHistory(source, env);
			const edited = `edited prompt after ${change}`;
			const order: string[] = [];
			const { api, apiCalls } = makeFakeApi(order);
			const fake = makeFakeCtx(order, {
				sessionFile,
				onEditor: () => {
					if (change === "delete") {
						unlinkSync(sessionFile);
					} else {
						const replacement = `${sessionFile}.replacement`;
						writeFileSync(replacement, sessionJsonl([], { id: "22222222-3333-4444-5555-666666666666", cwd: CWD }));
						renameSync(replacement, sessionFile);
					}
					return edited;
				},
			});

			await createHandler(api, { preflightHistory })(
				"goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);

			assert.equal(fake.calls.newSession, 0, change);
			assert.equal(fake.calls.sendUserMessage.length, 0, change);
			assert.deepEqual(fake.calls.oldSetEditorText, [edited], change);
			assert.deepEqual(apiCalls.setModel, [], change);
			assert.deepEqual(apiCalls.setThinkingLevel, [], change);
			assert.equal(fake.replacementCalls.setModel.length, 0, change);
			assert.equal(fake.replacementCalls.setThinkingLevel.length, 0, change);
			assert.equal(fake.notifications.at(-1)?.level, "error", change);
		}
	});
});

describe("handoff command lifecycle", () => {
	it("creates a reference-only handoff without requiring a model or reading conversation context", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const { ctx, calls, customMessages, replacementCalls } = makeFakeCtx(order);
		await createHandoffHandler(api)(
			"  implement teams support  ",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);

		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"newSession",
			"fresh.sendUserMessage",
		]);
		assert.equal(apiCalls.setModel.length, 0);
		assert.equal(replacementCalls.setModel.length, 0);
		assert.equal(replacementCalls.setThinkingLevel.length, 0);
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
		await createHandoffHandler(api)(
			"   ",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.ok(calls.editorDrafts[0].includes(DEFAULT_HANDOFF_GOAL));
		assert.deepEqual(calls.sessionNames, ["continue-implementation"]);
	});

	it("names the replacement from an edited goal", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, calls } = makeFakeCtx(order, {
			editorResult: "Continue work.\n\n## Goal\nShip the corrected archive workflow.\n",
		});
		await createHandoffHandler(api)(
			"old goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.deepEqual(calls.sessionNames, ["ship-corrected-archive"]);
	});

	it("notifies and stays in the old session when replacement is cancelled", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, customMessages } = makeFakeCtx(order, {
			newSessionResult: { cancelled: true },
		});
		await createHandoffHandler(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(notifications.at(-1)!.message, "New session cancelled");
		assert.equal(notifications.at(-1)!.level, "info");
		assert.equal(customMessages.length, 0);
		assert.ok(!order.includes("fresh.sendUserMessage"));
	});

	it("leaves the prompt in the editor when the replacement session has no model", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { freshModel: undefined });
		await createHandoffHandler(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
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
		await createHandoffHandler(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(calls.sendUserMessage.length, 0);
		assert.equal(calls.setEditorText.length, 1);
		assert.equal(notifications.at(-1)!.level, "warning");
		assert.ok(notifications.at(-1)!.message.includes("No credentials available"));
	});

	it("does not restore a possibly accepted prompt when sendUserMessage throws", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			freshModel: MODELS[2],
			sendUserMessageError: new Error("provider failed after accepting prompt"),
		});

		await assert.rejects(
			createHandoffHandler(api, fake.replacementApi)(
				"--model openai/gpt-5.2:high goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			),
			/provider failed after accepting prompt/,
		);
		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.equal(fake.calls.setEditorText.length, 0);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		// The replacement already starts on the requested model.
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["high"]);
	});
});

describe("archive-first handoff", () => {
	it("leaves malformed history active and does not replace or submit", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = tree.writeSession(SESSION_ID, "not-json\n");
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.editorDrafts.length, 1);
		assert.equal(fake.calls.newSession, 0);
		assert.equal(fake.calls.sendUserMessage.length, 0);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, []);
		assert.ok(fake.notifications.some(({ message }) => /malformed session file/i.test(message)));
		assert.equal(existsSync(sessionFile), true);
	});

	it("archives valid history before continuing in the replacement", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeArchiveSource(tree);
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive continue after archiving",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.equal(existsSync(sessionFile), false);
		assert.ok(fake.notifications.some(({ message }) => message.startsWith("Session archived:")));
		assert.ok(fake.customMessages[0].content.includes("Storage: archived before this handoff"));
	});

	it("accepts an oversized active source through archive staging", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeOversizedArchiveSource(tree);
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive continue after archiving",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.equal(existsSync(sessionFile), false);
		assert.ok(fake.notifications.some(({ message }) => message.startsWith("Session archived:")));
	});

	it("does not auto-submit when archive finalization fails", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeArchiveSource(tree);
		const collision = archiveDestination(tree.archiveRoot, SESSION_ID, "2026-08-11T08:48:02.226Z");
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
			beforeWithSession: () => {
				mkdirSync(dirname(collision), { recursive: true });
				writeFileSync(collision, "different archive content");
			},
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.calls.sendUserMessage.length, 0);
		assert.equal(existsSync(sessionFile), true);
		assert.ok(fake.notifications.some(({ message }) => /Archive finalization failed/i.test(message)));
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, []);
	});
});

describe("handoff editor cancellation", () => {
	it("creates no session when the editor is cancelled", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: undefined });
		await createHandoffHandler(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(notifications.at(-1)!.message, "Cancelled");
		assert.equal(calls.newSession, 0);
	});

	it("creates no session when the edited prompt is empty", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: "  \n" });
		await createHandoffHandler(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(notifications.at(-1)!.message, "Handoff prompt cannot be empty");
		assert.equal(notifications.at(-1)!.level, "error");
		assert.equal(calls.newSession, 0);
	});
});

describe("handoff replacement model selection", () => {
	it("applies the requested model and effort when replacement defaults differ", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
		});

		await createHandoffHandler(api, fake.replacementApi)(
			"--model openai/gpt-5.2:medium goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(order, [
			"waitForIdle",
			"getSessionFile",
			"getSessionId",
			"editor",
			"newSession",
			"replacement.setModel",
			"replacement.setThinkingLevel",
			"fresh.sendUserMessage",
		]);
		assert.deepEqual(fake.replacementCalls.setModel, [MODELS[2]]);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["medium"]);
		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.ok(fake.notifications.some((notification) => notification.message.includes("Model: openai/gpt-5.2:medium")));
	});

	it("inherits the parent model and effort through the replacement session API", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "high" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "high",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
		});

		await createHandoffHandler(api, fake.replacementApi)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(fake.replacementCalls.setModel, [PARENT_MODEL]);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["high"]);
		assert.ok(
			fake.notifications.some((notification) => notification.message.includes("Model: anthropic/claude-opus-4-6:high")),
		);
	});

	it("skips the model switch when the replacement already starts on the expected model", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "high" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "high",
			freshModel: PARENT_MODEL,
			freshThinkingLevel: "high",
		});

		await createHandoffHandler(api, fake.replacementApi)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, ["high"]);
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("reports a mismatch with the failure reason when the model cannot be applied", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
			replacementSetModelResult: false,
		});

		await createHandoffHandler(api, fake.replacementApi)(
			"--model openai/gpt-5.2:medium goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		const warning = fake.notifications.find((notification) => notification.level === "warning")!;
		assert.ok(warning.message.includes("could not apply openai/gpt-5.2:medium"));
		assert.ok(warning.message.includes("anthropic/claude-sonnet-4-5"));
		assert.ok(warning.message.includes("no credentials for openai/gpt-5.2"));
		assert.ok(!warning.message.includes("startup"));
		assert.ok(!warning.message.includes("scoping"));
		// The handoff still continues on the replacement's actual state.
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("reports the clamped effort when the requested level is unsupported", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
			replacementAvailableEfforts: ["off", "minimal", "low", "medium"],
		});

		await createHandoffHandler(api, fake.replacementApi)(
			"--model openai/gpt-5.2:xhigh goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		const warning = fake.notifications.find((notification) => notification.level === "warning")!;
		assert.ok(warning.message.includes("could not apply openai/gpt-5.2:xhigh"));
		assert.ok(warning.message.includes("openai/gpt-5.2:medium"));
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("warns without failing when no replacement API is bound", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "low" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "low",
			freshModel: MODELS[0],
			freshThinkingLevel: "low",
		});

		await createHandoffHandler(api, undefined)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		const warning = fake.notifications.find((notification) => notification.level === "warning")!;
		assert.ok(warning.message.includes("could not apply anthropic/claude-opus-4-6:low"));
		assert.ok(warning.message.includes("the replacement session API is unavailable"));
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("leaves the predecessor unchanged and skips selection when replacement is cancelled", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const fake = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			newSessionResult: { cancelled: true },
		});

		await createHandoffHandler(api, fake.replacementApi)(
			"--model openai/gpt-5.2:high goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, []);
		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.notifications.at(-1)!.message, "New session cancelled");
	});

	it("leaves the predecessor unchanged when replacement creation throws", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx } = makeFakeCtx(order, {
			model: PARENT_MODEL,
			thinkingLevel: "medium",
			newSessionError: new Error("runtime creation failed"),
		});

		await assert.rejects(
			createHandoffHandler(api)(
				"--model openai/gpt-5.2:high goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			),
			/runtime creation failed/,
		);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
	});

	it("accepts scoped model references without mutating the predecessor", async () => {
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			scopedModels: [{ model: MODELS[2] }, { model: MODELS[3] }],
		});

		await createHandoffHandler(api, fake.replacementApi)(
			"--model openai/gpt-5.2 goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);

		assert.equal(fake.calls.newSession, 1);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setModel, [MODELS[2]]);
	});

	it("rejects model references outside an active scope before replacement", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, {
			scopedModels: [{ model: MODELS[2] }, { model: MODELS[3] }],
		});

		await createHandoffHandler(api)(
			"--model anthropic/claude-sonnet-4-5 goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);

		assert.equal(calls.newSession, 0);
		assert.equal(notifications[0].level, "error");
		assert.ok(notifications[0].message.includes("scoping"));
	});

	it("rejects unknown and ambiguous references before opening the editor", async () => {
		for (const args of ["--model nope/does-not-exist goal", "--model gpt goal"]) {
			const order: string[] = [];
			const { api } = makeFakeApi(order);
			const { ctx, calls } = makeFakeCtx(order);
			await createHandoffHandler(api)(
				args,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
			);
			assert.equal(calls.editorDrafts.length, 0);
			assert.equal(calls.newSession, 0);
		}
	});

	it("does not leak model syntax into the continuation goal", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { thinkingLevel: "medium" });
		const { ctx, calls } = makeFakeCtx(order, { model: PARENT_MODEL, thinkingLevel: "medium" });

		await createHandoffHandler(api)(
			"--model openai/gpt-5.2:high ship the feature",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);

		const draft = calls.editorDrafts[0];
		assert.ok(draft.includes("## Goal\nship the feature"));
		assert.ok(!draft.includes("--model"));
		assert.ok(!draft.includes("gpt-5.2"));
		assert.ok(!draft.includes(":high"));
	});
});
