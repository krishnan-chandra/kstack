import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { claimSessionTransition, releaseSessionTransition } from "../shared/session-transition.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { preflightArchiveCurrentSession } from "./archive-ops.ts";
import {
	createArchiveCommands,
	createArchiveSessionToolController,
	createWriteGuard,
	reportBatchResults,
} from "./registration.ts";
import { makeTempTree, messageEntry, sessionJsonl, userMessage } from "./test-helpers.ts";

const roots: string[] = [];
const SESSION_ID = "11111111-2222-3333-4444-555555555555";
afterEach(() => {
	releaseSessionTransition(SESSION_ID);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createWriteGuard", () => {
	it("blocks write and edit targeting the archive root and ignores other tools", async () => {
		const guard = createWriteGuard("/tmp/archive");
		const ctx = { cwd: "/repo" };
		const blocked = await guard(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				toolName: "write",
				input: { path: "/tmp/archive/2026/01/session.jsonl" },
			} as never,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /read-only/);

		const editBlocked = await guard(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				toolName: "edit",
				input: { path: "/tmp/archive/notes.md" },
			} as never,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(editBlocked?.block, true);

		const ignored = await guard(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				toolName: "read",
				input: { path: "/tmp/archive/notes.md" },
			} as never,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(ignored, undefined);

		const nonString = await guard(
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				toolName: "write",
				input: { path: 12 },
			} as never,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(nonString, undefined);
	});
});

describe("reportBatchResults", () => {
	it("formats mixed success and failure outcomes", () => {
		const messages: Array<{ text: string; level: string }> = [];
		reportBatchResults(
			(message, level) => {
				messages.push({ text: message, level });
			},
			[
				{ sourcePath: "/a.jsonl", result: { status: "archived", message: "ok" } },
				{ sourcePath: "/b.jsonl", result: { status: "rejected", message: "current session" } },
				{ sourcePath: "/c.jsonl", result: { status: "failed", message: "move failed" } },
			],
		);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].level, "warning");
		assert.match(messages[0].text, /1 archived, 1 skipped, 1 failed/);
		assert.match(messages[0].text, /Skipped: \/b.jsonl — current session/);
		assert.match(messages[0].text, /Failed: \/c.jsonl — move failed/);
	});
});

describe("createArchiveCommands", () => {
	it("archives the current session with the session id and name from ctx", async () => {
		const calls: BoundaryValue[] = [];
		const commands = createArchiveCommands({
			archiveRoot: "/archive",
			activeSessionsRoot: "/sessions",
			dbPath: "/archive/index.db",
			archiveCurrentSession: async (options) => {
				calls.push(options);
				return { status: "archived", message: "ok" };
			},
			archiveInactiveSessions: async () => [],
			restoreArchivedSession: async () => ({ status: "archived", message: "restored" }),
			reconcileArchive: () => ({ finalized: [], leftPending: [], errors: [], restored: [] }),
			listArchivedSessionSummaries: () => [],
			inspectArchiveIntegrity: () => [],
			openArchiveDb: () =>
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ({
					close() {},
				}) as never,
		});
		const ctx = {
			sessionManager: {
				getSessionId: () => "11111111-2222-3333-4444-555555555555",
				getSessionName: () => "current-work",
				getSessionFile: () => "/sessions/current.jsonl",
				getSessionDir: () => "/sessions",
			},
			waitForIdle: async () => {},
			ui: {
				confirm: async () => true,
				notify() {},
			},
			newSession: async () => ({ cancelled: false }),
		};
		await commands.sessionArchive(
			"",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(calls.length, 1);
		const options = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ calls[0] as {
			snapshot: { sessionId: string; sessionName?: string };
		};
		assert.equal(options.snapshot.sessionId, "11111111-2222-3333-4444-555555555555");
		assert.equal(options.snapshot.sessionName, "current-work");
	});

	it("skips confirmation only when given a valid claimed tool token", async () => {
		const calls: Array<{ skipConfirmation?: boolean }> = [];
		const commands = createArchiveCommands({
			archiveRoot: "/archive",
			activeSessionsRoot: "/sessions",
			dbPath: "/archive/index.db",
			archiveCurrentSession: async (options) => {
				calls.push({ skipConfirmation: options.skipConfirmation });
				return { status: "archived", message: "ok" };
			},
			archiveInactiveSessions: async () => [],
			restoreArchivedSession: async () => ({ status: "archived", message: "restored" }),
			reconcileArchive: () => ({ finalized: [], leftPending: [], errors: [], restored: [] }),
			listArchivedSessionSummaries: () => [],
			inspectArchiveIntegrity: () => [],
			openArchiveDb: () =>
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ({
					close() {},
				}) as never,
		});
		const ctx = {
			sessionManager: {
				getSessionId: () => SESSION_ID,
				getSessionName: () => "current-work",
				getSessionFile: () => "/sessions/current.jsonl",
				getSessionDir: () => "/sessions",
			},
			waitForIdle: async () => {},
			ui: { confirm: async () => true, notify() {} },
			newSession: async () => ({ cancelled: false }),
		};

		await commands.sessionArchive(
			"--tool-token=forged-token",
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(calls[0]?.skipConfirmation, false);

		const token = claimSessionTransition(SESSION_ID, "archive_session");
		assert.ok(token);
		await commands.sessionArchive(
			`--tool-token=${token}`,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(calls[1]?.skipConfirmation, true);

		// Token is one-time only.
		await commands.sessionArchive(
			`--tool-token=${token}`,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ctx as never,
		);
		assert.equal(calls[2]?.skipConfirmation, false);
	});
});

describe("archive_session tool controller", () => {
	it("preflights, terminates, dispatches on settle, and releases on abort or shutdown", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = tree.writeSession(
			SESSION_ID,
			sessionJsonl([messageEntry("u1", null, userMessage("work done"))], { id: SESSION_ID }),
		);

		const sent: Array<{ content: string; options: { expandPromptTemplates: boolean } }> = [];
		const controller = createArchiveSessionToolController({
			archiveRoot: tree.archiveRoot,
			preflight: preflightArchiveCurrentSession,
			sendUserMessage: (content, options) => sent.push({ content, options }),
		});

		const sessionCtx = {
			sessionManager: {
				getSessionId: () => SESSION_ID,
				getSessionFile: () => sessionFile,
				getSessionDir: () => tree.sessionDir,
			},
		};

		const result = await controller.execute(
			"call-1",
			{},
			undefined,
			undefined,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		assert.equal(result.terminate, true);
		assert.equal(result.details.scheduled, true);

		// A duplicate claim in the same session is rejected.
		await assert.rejects(
			controller.execute(
				"call-2",
				{},
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
			),
			/already scheduled/i,
		);

		// Aborted settle releases the slot without dispatching the command.
		controller.onAgentSettled(
			{ aborted: true },
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		assert.equal(sent.length, 0);

		// Now a fresh request succeeds and dispatches on non-aborted settle.
		await controller.execute(
			"call-3",
			{},
			undefined,
			undefined,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		controller.onAgentSettled(
			{ aborted: false },
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /^\/session-archive --tool-token=[0-9a-f-]+$/);
		assert.deepEqual(sent[0].options, { expandPromptTemplates: true });

		// If shutdown occurs after dispatch but before command consumption,
		// onSessionShutdown releases the dispatched token without leaving a leak.
		controller.onSessionShutdown(
			{},
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		const afterDispatchedShutdown = claimSessionTransition(SESSION_ID, "handoff");
		assert.ok(afterDispatchedShutdown);
		releaseSessionTransition(SESSION_ID, afterDispatchedShutdown);

		// Consuming a dispatched token via consumeToolToken also frees the slot.
		await controller.execute(
			"call-4",
			{},
			undefined,
			undefined,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		controller.onAgentSettled(
			{ aborted: false },
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		const dispatchedToken = sent[1].content.replace(/^\/session-archive --tool-token=/, "");
		assert.equal(controller.consumeToolToken(SESSION_ID, dispatchedToken), true);
		assert.equal(controller.consumeToolToken(SESSION_ID, dispatchedToken), false);

		// And session_shutdown before settle releases pending state too.
		await controller.execute(
			"call-5",
			{},
			undefined,
			undefined,
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		controller.onSessionShutdown(
			{},
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ sessionCtx as never,
		);
		// Slot is free again after shutdown cleanup.
		const afterShutdown = claimSessionTransition(SESSION_ID, "archive_session");
		assert.ok(afterShutdown);
	});

	it("rejects ephemeral, malformed, and empty sessions before scheduling", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const malformedFile = tree.writeSession(SESSION_ID, "not-json\n");
		const emptyFile = tree.writeSession(
			"22222222-3333-4444-5555-666666666666",
			sessionJsonl([], {
				id: "22222222-3333-4444-5555-666666666666",
			}),
		);

		const controller = createArchiveSessionToolController({
			archiveRoot: tree.archiveRoot,
			preflight: preflightArchiveCurrentSession,
			sendUserMessage: () => assert.fail("must not send"),
		});

		await assert.rejects(
			controller.execute(
				"call-e",
				{},
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
					sessionManager: {
						getSessionId: () => SESSION_ID,
						getSessionFile: () => undefined,
						getSessionDir: () => tree.sessionDir,
					},
				} as never,
			),
			/ephemeral/i,
		);

		await assert.rejects(
			controller.execute(
				"call-m",
				{},
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
					sessionManager: {
						getSessionId: () => SESSION_ID,
						getSessionFile: () => malformedFile,
						getSessionDir: () => tree.sessionDir,
					},
				} as never,
			),
			/malformed/i,
		);

		await assert.rejects(
			controller.execute(
				"call-0",
				{},
				undefined,
				undefined,
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
					sessionManager: {
						getSessionId: () => "22222222-3333-4444-5555-666666666666",
						getSessionFile: () => emptyFile,
						getSessionDir: () => tree.sessionDir,
					},
				} as never,
			),
			/no entries yet/i,
		);

		// None of the rejections claimed the transition slot.
		assert.ok(claimSessionTransition(SESSION_ID, "archive_session"));
	});
});
