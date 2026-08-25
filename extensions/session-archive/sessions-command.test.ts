import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionsCommand } from "./sessions-command.ts";

function archivedSummary() {
	return {
		state: "archived" as const,
		sessionId: "archive-id",
		cwd: "/repo",
		name: "Archived",
		firstUserText: "work",
		messageCount: 2,
		originalPath: "/sessions/archive.jsonl",
		archivePath: "/archive/archive.jsonl",
		lastError: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastMessageAt: "2026-01-02T00:00:00.000Z",
	};
}

function fakeContext(notifications: Array<{ message: string; level: string }>) {
	return /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
		hasUI: true,
		mode: "rpc",
		sessionManager: {
			getSessionFile: () => "/sessions/current.jsonl",
			getSessionId: () => "current-id",
			getSessionDir: () => "/sessions",
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	} as never;
}

function baseDeps() {
	return {
		archiveRoot: "/archive",
		activeSessionsRoot: "/sessions",
		dbPath: "/archive/index.sqlite3",
		archiveCurrentSession: async () => ({ status: "archived" as const, message: "archived" }),
		archiveInactiveSessions: async () => [],
		restoreArchivedSession: async () => ({ status: "archived" as const, message: "restored" }),
		reconcileArchive: () => ({ finalized: [], leftPending: [], errors: [], restored: [] }),
		listArchivedSessionSummaries: () => [archivedSummary()],
		inspectArchiveIntegrity: () => [],
		openArchiveDb: () =>
			/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ({ close() {} }) as never,
		listActiveSessions: async () => [],
	};
}

describe("createSessionsCommand", () => {
	it("defers integrity work until selection and checks only the selected archive", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		const inspections: Array<{ sessionId?: string; limit?: number }> = [];
		let restoreCalls = 0;
		let selections = 0;
		const command = createSessionsCommand({
			...baseDeps(),
			inspectArchiveIntegrity: (_dbPath, options = {}) => {
				inspections.push(options);
				return [{ sessionId: "archive-id", message: "hash mismatch" }];
			},
			restoreArchivedSession: async () => {
				restoreCalls++;
				return { status: "archived", message: "restored" };
			},
			selectToggle: async (_ctx, rows) => {
				selections++;
				return selections === 1 ? rows.find((row) => row.id === "archive-id") : undefined;
			},
		});
		await command("", fakeContext(notifications));
		assert.deepEqual(inspections, [{ sessionId: "archive-id" }]);
		assert.equal(restoreCalls, 0);
		assert.match(notifications.at(-1)?.message ?? "", /archive-id: hash mismatch/);
	});

	it("validates globally listed inactive sessions against the configured sessions root", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		let selected = false;
		let archiveSessionDir: string | undefined;
		const command = createSessionsCommand({
			...baseDeps(),
			listArchivedSessionSummaries: () => [],
			listActiveSessions: async () => [
				{
					id: "inactive-id",
					path: "/agent/sessions/project/inactive.jsonl",
					cwd: "/repo",
					created: new Date("2026-01-01"),
					modified: new Date("2026-01-02"),
					firstMessage: "work",
				},
			],
			archiveInactiveSessions: async (options) => {
				archiveSessionDir = options.sessionDir;
				return [{ sourcePath: options.sourcePaths[0] ?? "", result: { status: "archived", message: "done" } }];
			},
			selectToggle: async (_ctx, rows) => {
				if (selected) return undefined;
				selected = true;
				return rows.find((row) => row.id === "inactive-id");
			},
			activeSessionsRoot: "/agent/sessions",
		});
		await command("", fakeContext(notifications));
		assert.equal(archiveSessionDir, "/agent/sessions");
	});

	it("shows error-row paths and diagnostics without attempting a toggle", async () => {
		const notifications: Array<{ message: string; level: string }> = [];
		let selections = 0;
		const command = createSessionsCommand({
			...baseDeps(),
			listArchivedSessionSummaries: () => [
				{
					...archivedSummary(),
					state: "error" as const,
					lastError: "restore failed",
				},
			],
			selectToggle: async (_ctx, rows) => {
				selections++;
				return selections === 1 ? rows.find((row) => row.id === "archive-id") : undefined;
			},
		});
		await command("", fakeContext(notifications));
		const detail = notifications.find(({ message }) => message.includes("Original path"));
		assert.match(detail?.message ?? "", /restore failed/);
		assert.match(detail?.message ?? "", /\/sessions\/archive.jsonl/);
		assert.match(detail?.message ?? "", /\/archive\/archive.jsonl/);
	});
});
