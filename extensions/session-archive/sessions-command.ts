import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CommandContext } from "./registration.ts";
import type { ActiveSessionInfo } from "./sessions.ts";
import { buildSessionRows } from "./sessions.ts";
import { selectSessionToggle } from "./sessions-picker.ts";

type SessionsCommandDeps = {
	archiveRoot: string;
	activeSessionsRoot: string;
	dbPath: string;
	archiveCurrentSession: typeof import("./archive-ops.ts").archiveCurrentSession;
	archiveInactiveSessions: typeof import("./archive-ops.ts").archiveInactiveSessions;
	restoreArchivedSession: typeof import("./archive-ops.ts").restoreArchivedSession;
	reconcileArchive: typeof import("./reconcile.ts").reconcileArchive;
	listArchivedSessionSummaries: typeof import("./archive-store.ts").listArchivedSessionSummaries;
	inspectArchiveIntegrity: typeof import("./reconcile.ts").inspectArchiveIntegrity;
	openArchiveDb: typeof import("./archive-store.ts").openArchiveDb;
	listActiveSessions?: () => Promise<ActiveSessionInfo[]>;
	selectToggle?: typeof selectSessionToggle;
};

/** Run the unified active/archive browser with all effects injected for tests. */
export function createSessionsCommand(deps: SessionsCommandDeps) {
	const listActiveSessions = deps.listActiveSessions ?? (() => SessionManager.listAll());
	const selectToggle = deps.selectToggle ?? selectSessionToggle;

	return async (_args: string, ctx: CommandContext): Promise<void> => {
		while (true) {
			const report = deps.reconcileArchive({
				dbPath: deps.dbPath,
				currentSessionFile: ctx.sessionManager.getSessionFile(),
			});
			if (report.errors.length > 0) {
				ctx.ui.notify(
					`Session archive recovery found ${report.errors.length} issue(s). Select an error row for paths and details.`,
					"warning",
				);
			}

			const db = deps.openArchiveDb(deps.dbPath);
			let rows: ReturnType<typeof buildSessionRows>;
			try {
				const active = await listActiveSessions();
				rows = buildSessionRows(active, deps.listArchivedSessionSummaries(db), ctx.sessionManager.getSessionFile());
			} finally {
				db.close();
			}
			if (rows.length === 0) {
				ctx.ui.notify("No persisted sessions found.", "info");
				return;
			}

			const action = await selectToggle(ctx, rows);
			if (!action) return;
			if (action.kind === "error") {
				ctx.ui.notify(action.detail, "warning");
				continue;
			}
			if (action.kind === "archived") {
				const integrity = deps.inspectArchiveIntegrity(deps.dbPath, { sessionId: action.id });
				if (integrity.length > 0) {
					const details = integrity.map((issue) => `${issue.sessionId}: ${issue.message}`).join("\n");
					ctx.ui.notify(`Cannot restore until archive integrity is repaired:\n${details}`, "error");
					continue;
				}
				const result = await deps.restoreArchivedSession({
					deps: { dbPath: deps.dbPath, archiveRoot: deps.archiveRoot },
					sessionId: action.id,
				});
				ctx.ui.notify(result.message, result.status === "archived" ? "info" : "error");
				continue;
			}
			if (action.current) {
				await deps.archiveCurrentSession({
					deps: { dbPath: deps.dbPath, archiveRoot: deps.archiveRoot },
					snapshot: {
						sourcePath: ctx.sessionManager.getSessionFile(),
						sessionId: ctx.sessionManager.getSessionId(),
						sessionDir: ctx.sessionManager.getSessionDir(),
						sessionName: ctx.sessionManager.getSessionName()?.trim() || undefined,
					},
					waitForIdle: () => ctx.waitForIdle(),
					skipConfirmation: true,
					notify: (message, level) => ctx.ui.notify(message, level),
					startNewSession: (withSession) =>
						ctx.newSession({
							withSession: async (fresh) =>
								withSession({ notify: (message, level) => fresh.ui.notify(message, level) }),
						}),
				});
				return;
			}

			const result = await deps.archiveInactiveSessions({
				deps: { dbPath: deps.dbPath, archiveRoot: deps.archiveRoot },
				sourcePaths: [action.path],
				currentSessionFile: ctx.sessionManager.getSessionFile(),
				sessionDir: deps.activeSessionsRoot,
			});
			ctx.ui.notify(
				result[0]?.result.message ?? "Session toggle failed.",
				result[0]?.result.status === "archived" ? "info" : "error",
			);
		}
	};
}
