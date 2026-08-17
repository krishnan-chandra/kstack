import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArchiveCommands, createWriteGuard, reportBatchResults } from "./registration.ts";

describe("createWriteGuard", () => {
	it("blocks write and edit targeting the archive root and ignores other tools", async () => {
		const guard = createWriteGuard("/tmp/archive");
		const ctx = { cwd: "/repo" };
		const blocked = await guard(
			{ toolName: "write", input: { path: "/tmp/archive/2026/01/session.jsonl" } } as never,
			ctx as never,
		);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /read-only/);

		const editBlocked = await guard(
			{ toolName: "edit", input: { path: "/tmp/archive/notes.md" } } as never,
			ctx as never,
		);
		assert.equal(editBlocked?.block, true);

		const ignored = await guard({ toolName: "read", input: { path: "/tmp/archive/notes.md" } } as never, ctx as never);
		assert.equal(ignored, undefined);

		const nonString = await guard({ toolName: "write", input: { path: 12 } } as never, ctx as never);
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
		const calls: unknown[] = [];
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
			openArchiveDb: () => ({ close() {} }) as never,
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
		await commands.sessionArchive("", ctx as never);
		assert.equal(calls.length, 1);
		const options = calls[0] as { snapshot: { sessionId: string; sessionName?: string } };
		assert.equal(options.snapshot.sessionId, "11111111-2222-3333-4444-555555555555");
		assert.equal(options.snapshot.sessionName, "current-work");
	});
});
