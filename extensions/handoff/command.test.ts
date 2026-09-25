import assert from "node:assert/strict";
import { renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeTempTree, messageEntry, sessionJsonl, userMessage } from "../session-archive/test-helpers.ts";
import { createHandoffHandler as createHandler } from "./command.ts";
import {
	CWD,
	createHandlerWithStubs,
	MODELS,
	makeFakeApi,
	makeFakeCtx,
	PARENT_MODEL,
	SESSION_FILE,
	SESSION_ID,
} from "./command-test-fixtures.ts";
import { DEFAULT_HANDOFF_GOAL } from "./handoff-context.ts";
import { type HandoffSource, preflightHandoffHistory } from "./history-reader.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("handoff command guards", () => {
	it("rejects non-TUI mode", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications } = makeFakeCtx(order, { mode: "rpc" });
		await createHandlerWithStubs(api)(
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
		await createHandlerWithStubs(api)(
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
		await createHandlerWithStubs(api)(
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
		assert.ok(customMessages[0].content.includes("read_handoff_history and search_handoff_history"));
		assert.ok(!customMessages[0].content.includes("read_session_archive"));
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
		await createHandlerWithStubs(api)(
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
		await createHandlerWithStubs(api)(
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
		await createHandlerWithStubs(api)(
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
		await createHandlerWithStubs(api)(
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
		await createHandlerWithStubs(api)(
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
			createHandlerWithStubs(api, fake.replacementApi)(
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

describe("handoff editor cancellation", () => {
	it("creates no session when the editor is cancelled", async () => {
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const { ctx, notifications, calls } = makeFakeCtx(order, { editorResult: undefined });
		await createHandlerWithStubs(api)(
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
		await createHandlerWithStubs(api)(
			"goal",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(notifications.at(-1)!.message, "Handoff prompt cannot be empty");
		assert.equal(notifications.at(-1)!.level, "error");
		assert.equal(calls.newSession, 0);
	});
});

describe("handoff history access", () => {
	async function handoff(active: string[], registeredOnly: string[] = []) {
		const order: string[] = [];
		const { api } = makeFakeApi(order, { active, registeredOnly });
		const fake = makeFakeCtx(order);
		await createHandlerWithStubs(api)(
			"review the diff",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
		);
		return { ...fake, order, draft: fake.calls.editorDrafts[0] ?? "" };
	}

	it("uses the outline reader without search instructions when only read_handoff_history is allowed", async () => {
		const { draft, notifications, calls } = await handoff(["read_handoff_history"]);

		assert.ok(draft.includes("1. Call read_handoff_history first, with no arguments."));
		assert.ok(draft.includes("3. Inherit prior decisions"));
		assert.ok(draft.includes("Lookup: read_handoff_history finds this session"));
		assert.ok(!draft.includes("search_handoff_history"));
		assert.ok(!draft.includes("transcript JSONL"));
		assert.ok(
			notifications.some(({ level, message }) => level === "warning" && message.includes("read_handoff_history only")),
		);
		assert.equal(calls.sendUserMessage.length, 1);
	});

	it("points the replacement at the transcript file with the file tools it will have", async () => {
		const { draft, notifications, customMessages, calls } = await handoff(["read", "grep", "find", "ls"]);

		assert.ok(
			notifications.some(({ level, message }) => level === "warning" && message.includes("transcript file instead")),
		);
		assert.ok(draft.includes("This session cannot use the handoff history tools"));
		assert.ok(draft.includes("Search it with grep for the user requests"));
		assert.ok(draft.includes("read only those line ranges with read"));
		assert.ok(draft.includes(`read the transcript JSONL at ${SESSION_FILE} with read and grep.`));
		assert.ok(!draft.includes("Call read_handoff_history"));
		assert.ok(!draft.includes("do not open the session file directly"));
		assert.ok(customMessages[0].content.includes(`read the transcript JSONL at ${SESSION_FILE}`));
		assert.deepEqual(calls.sendUserMessage, [`EDITED ${draft}`]);
	});

	it("stops before the editor when no tool could read the previous session", async () => {
		const { order, notifications, calls } = await handoff(["ls", "find"]);

		assert.equal(calls.editorDrafts.length, 0);
		assert.equal(calls.newSession, 0);
		assert.ok(!order.includes("editor"));
		assert.equal(notifications.at(-1)?.level, "error");
		assert.match(
			notifications.at(-1)?.message ?? "",
			/^Cannot hand off: .*no tool that can read the previous session/u,
		);
	});
});
