/** Fake Pi command and replacement-session contexts shared by the handoff command tests. */

import assert from "node:assert/strict";
import type { BoundaryValue } from "../shared/validation.ts";
import { createHandoffHandler as createHandler } from "./command.ts";
import type { HandoffEffortLevel, HandoffModel } from "./model-selection.ts";
import type { ReplacementSelectionApi } from "./replacement-selection-api.ts";

export const SESSION_FILE = "/sessions/old.jsonl";
export const SESSION_ID = "11111111-2222-3333-4444-555555555555";
export const CWD = "/proj";
/** Header timestamp of the fake session; archive paths derive from it. */
export const HEADER_TIMESTAMP = "2026-08-11T08:48:02.226Z";

export const MODELS: HandoffModel[] = [
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
	{ provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
	{ provider: "openai", id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
];

export const PARENT_MODEL: HandoffModel = { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" };
const ALL_EFFORTS: HandoffEffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export async function withAgentDir(agentDir: string, run: () => Promise<void>): Promise<void> {
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

/** A handler whose preflight always succeeds and whose replacement API is the given fake. */
export function createHandlerWithStubs(
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
const DEFAULT_ACTIVE_TOOLS = ["read", "bash", "edit", "write", "read_handoff_history", "search_handoff_history"];

/**
 * `active` tools are active now; `registeredOnly` tools are registered but
 * inactive, like Pi's built-in grep, find, and ls without an allowlist.
 */
export function makeFakeApi(
	order: string[],
	opts: { thinkingLevel?: string; active?: string[]; registeredOnly?: string[] } = {},
) {
	const thinkingLevel = opts.thinkingLevel ?? "";
	const active = opts.active ?? DEFAULT_ACTIVE_TOOLS;
	const registered = [...active, ...(opts.registeredOnly ?? ["grep", "find", "ls"])];
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
		getAllTools: () => registered.map((name) => ({ name })),
		getActiveTools: () => active,
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

export function makeFakeCtx(order: string[], opts: FakeCtxOptions = {}) {
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
			getHeader: () => ({ type: "session", id: SESSION_ID, timestamp: HEADER_TIMESTAMP, cwd: CWD }),
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
