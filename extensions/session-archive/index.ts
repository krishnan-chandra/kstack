/**
 * Session Archive extension for Pi.
 *
 * Moves completed sessions out of Pi's active session directories into a
 * read-only archive under `$PI_CODING_AGENT_DIR/archive/`, indexes them in a
 * local SQLite/FTS5 database, and exposes SELECT-only search/read tools to
 * agents. Mutation is an explicit, confirmed user command — no agent-callable
 * tool can archive, restore, edit, or delete a session. The /sessions browser is the only immediate-toggle surface.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { ensureArchiveDirs, getArchiveDbPath, getArchiveRoot } from "./archive-files.ts";
import { createArchiveCommands, createArchiveTools, createWriteGuard } from "./registration.ts";

export default async function (pi: ExtensionAPI) {
	guardCommandFallthrough(pi, "session-archive", "sessions", "session-archive-other", "session-archive-all");
	let sqliteAvailable = true;
	try {
		await import("node:sqlite");
	} catch {
		sqliteAvailable = false;
	}

	const archiveRoot = getArchiveRoot();
	const dbPath = getArchiveDbPath(archiveRoot);

	if (!sqliteAvailable) {
		const message =
			"session-archive requires Node 22 or newer (node:sqlite is unavailable). " +
			"Upgrade Node or run Pi with a newer runtime to enable session archiving.";
		for (const [name, description] of [["session-archive", "Archive the current session"], ["sessions", "Browse and toggle session archive status"]] as const) {
			pi.registerCommand(name, { description: `${description} (unavailable: Node 22+ required)`, handler: async (_args, ctx) => ctx.ui.notify(message, "error") });
		}
		pi.on("session_start", async (_event, ctx) => ctx.ui.notify(message, "warning"));
		return;
	}

	const {
		getArchiveStats,
		getSessionRow,
		countEntries,
		listSessionRows,
		listArchivedSessionSummaries,
		openArchiveDb,
		openArchiveDbReadOnly,
		readEntries,
		searchArchive,
	} = await import("./archive-store.ts");
	const { archiveCurrentSession, archiveInactiveSessions, restoreArchivedSession } = await import("./archive-ops.ts");
	const { inspectArchiveIntegrity, reconcileArchive } = await import("./reconcile.ts");

	const commands = createArchiveCommands({
		archiveRoot,
		dbPath,
		archiveCurrentSession,
		archiveInactiveSessions,
		restoreArchivedSession,
		reconcileArchive,
		listArchivedSessionSummaries,
		inspectArchiveIntegrity,
		getArchiveStats,
		listSessionRows,
		openArchiveDb,
	});
	const tools = createArchiveTools({
		dbPath,
		getSessionRow,
		countEntries,
		openArchiveDbReadOnly,
		readEntries,
		searchArchive,
	});

	// Write/edit guard: archived content is read-only for agents.
	pi.on("tool_call", async (event, ctx) => createWriteGuard(archiveRoot)(event, ctx));

	pi.on("session_start", async (_event, ctx) => {
		try {
			ensureArchiveDirs(archiveRoot);
			const report = reconcileArchive({
				dbPath,
				currentSessionFile: ctx.sessionManager.getSessionFile(),
			});
			const problems = report.errors.length;
			if (report.finalized.length > 0) {
				ctx.ui.notify(`session-archive: recovered ${report.finalized.length} interrupted archive(s).`, "info");
			}
			if (problems > 0) {
				ctx.ui.notify(
					`session-archive: ${problems} archive integrity problem(s); run /sessions for details.`,
					"warning",
				);
			}
		} catch (err) {
			ctx.ui.notify(`session-archive reconciliation failed: ${(err as Error).message}`, "warning");
		}
	});

	pi.registerCommand("session-archive", {
		description: "Archive the current session (read-only, searchable) and start a new one",
		handler: commands.sessionArchive,
	});

	pi.registerCommand("sessions", {
		description: "Browse all persisted sessions and archive or restore one immediately",
		handler: commands.sessions,
	});

	pi.registerCommand("session-archive-other", {
		description: "Select one or more inactive sessions and archive them",
		handler: commands.sessionArchiveOther,
	});

	pi.registerCommand("session-archive-all", {
		description: "Archive every inactive session in this directory in one confirmed batch",
		handler: commands.sessionArchiveAll,
	});

	pi.registerTool({
		name: "search_session_archive",
		label: "Search Session Archive",
		description:
			"Full-text search over archived Pi sessions. Returns matching entries with highlighted snippets, " +
			"session id, entry id, role, and timestamp. Read-only: the archive cannot be modified by tools. " +
			"Use read_session_archive with a session id to page through full entries.",
		parameters: Type.Object({
			query: Type.String({
				description: 'FTS5 query: plain words, "quoted phrases", AND/OR/NOT, prefix* terms',
			}),
			cwd: Type.Optional(Type.String({ description: "Only sessions whose working directory equals this path" })),
			role: Type.Optional(
				Type.String({
					description: "Only entries with this role (user, assistant, toolResult, bashExecution, custom)",
				}),
			),
			session_id: Type.Optional(Type.String({ description: "Only entries from this archived session id" })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default 20, max 100)" }),
			),
		}),
		execute: tools.searchSessionArchive,
	});

	pi.registerTool({
		name: "read_session_archive",
		label: "Read Session Archive",
		description:
			"Page through the entries of one archived session by exact session id. " +
			"Returns normalized metadata and extracted text, or exact raw JSONL lines with format='raw'. " +
			"Large pages are split into bounded chunks; follow the returned chunk/offset continuation. Read-only.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Exact archived session id" }),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 2_147_483_647, description: "Entry offset to start from (default 0)" }),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 200, description: "Entries per page (default 50, max 200)" }),
			),
			format: Type.Optional(
				StringEnum(["normalized", "raw"] as const, {
					description: "'normalized' (default) or 'raw' JSONL lines",
				}),
			),
			chunk: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Chunk within this entry page (default 0)" }),
			),
		}),
		execute: tools.readSessionArchive,
	});
}
