/**
 * Session Archive extension for Pi.
 *
 * Moves completed sessions out of Pi's active session directories into a
 * read-only archive under `$PI_CODING_AGENT_DIR/archive/`, indexes them in a
 * local SQLite/FTS5 database, and exposes SELECT-only search/read tools to
 * agents. Mutation is an explicit, confirmed user command — no agent-callable
 * tool can archive, restore, edit, or delete a session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, SessionManager, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	ensureArchiveDirs,
	fileExists,
	fileSize,
	getArchiveDbPath,
	getArchiveRoot,
	isArchiveWriteTarget,
	readUtf8Ranges,
} from "./archive-files.ts";
import { buildSessionChoices } from "./session-choices.ts";
import { splitUtf8Chunks } from "./tool-output.ts";

type ArchiveResult =
	| { status: "archived"; message: string }
	| { status: "cancelled"; message: string }
	| { status: "rejected"; message: string }
	| { status: "failed"; message: string };

export default async function (pi: ExtensionAPI) {
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
		pi.registerCommand("session-archive", {
			description: "Archive the current session (unavailable: Node 22+ required)",
			handler: async (_args, ctx) => ctx.ui.notify(message, "error"),
		});
		pi.on("session_start", async (_event, ctx) => ctx.ui.notify(message, "warning"));
		return;
	}

	const {
		getArchiveStats,
		getSessionRow,
		countEntries,
		listSessionRows,
		openArchiveDb,
		openArchiveDbReadOnly,
		readEntries,
		searchArchive,
	} = await import("./archive-store.ts");
	const { archiveCurrentSession, archiveInactiveSession, archiveInactiveSessions } = await import(
		"./archive-ops.ts"
	);
	const { inspectArchiveIntegrity, reconcileArchive } = await import("./reconcile.ts");

	// Write/edit guard: archived content is read-only for agents.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const target = (event.input as { path?: unknown }).path;
		if (typeof target !== "string" || target.length === 0) return;
		if (isArchiveWriteTarget(target, ctx.cwd, archiveRoot)) {
			return {
				block: true,
				reason:
					"The session archive is read-only. Archived sessions can be searched with " +
					"search_session_archive and read with read_session_archive, but never modified.",
			};
		}
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			ensureArchiveDirs(archiveRoot);
			const report = reconcileArchive({
				dbPath,
				currentSessionFile: ctx.sessionManager.getSessionFile(),
			});
			const problems = report.errors.length + report.integrity.length;
			if (report.finalized.length > 0) {
				ctx.ui.notify(`session-archive: recovered ${report.finalized.length} interrupted archive(s).`, "info");
			}
			if (problems > 0) {
				ctx.ui.notify(
					`session-archive: ${problems} archive integrity problem(s); run /session-archives for details.`,
					"warning",
				);
			}
		} catch (err) {
			ctx.ui.notify(`session-archive reconciliation failed: ${(err as Error).message}`, "warning");
		}
	});

	pi.registerCommand("session-archive", {
		description: "Archive the named current session (read-only, searchable) and start a new one",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const sessionName = ctx.sessionManager.getSessionName();
			if (!sessionName) {
				ctx.ui.notify("Name this session with /name <name>, then retry /session-archive.", "warning");
				return;
			}
			await archiveCurrentSession({
				deps: { dbPath, archiveRoot },
				snapshot: {
					sourcePath: ctx.sessionManager.getSessionFile(),
					sessionId,
					sessionDir: ctx.sessionManager.getSessionDir(),
					sessionName,
				},
				waitForIdle: () => ctx.waitForIdle(),
				confirm: (title, message) => ctx.ui.confirm(title, message),
				notify: (message, level) => ctx.ui.notify(message, level),
				startNewSession: (withSession) =>
					// Deliberately no parentSession: the archive destination does not
					// exist yet, and SQLite preserves the archive relationship.
					ctx.newSession({
						withSession: async (freshCtx) => {
							await withSession({
								notify: (message, level) => freshCtx.ui.notify(message, level),
							});
						},
					}),
			});
		},
	});

	pi.registerCommand("session-archives", {
		description: "List archive stats and archived sessions (read-only)",
		handler: async (args, ctx) => {
			const integrity = inspectArchiveIntegrity(dbPath);
			const db = openArchiveDb(dbPath);
			try {
				const stats = getArchiveStats(db);
				const lines: string[] = [
					`Archive: ${stats.sessionsArchived} archived, ${stats.sessionsPending} pending, ${stats.sessionsError} error, ${stats.entriesTotal} entries indexed`,
				];
				if (integrity.length > 0) {
					lines.push("", `Integrity problems (${integrity.length}):`);
					for (const issue of integrity) {
						lines.push(`  ${issue.sessionId}: ${issue.message}`);
					}
				}
				try {
					lines.push(`Database size: ${(fileSize(dbPath) / 1024).toFixed(0)} KiB`);
				} catch {
					// DB file may not exist yet.
				}

				const filter = args?.trim() ? args.trim().toLowerCase() : undefined;
				const rows = listSessionRows(db, { limit: 50 }).filter(
					(row) =>
						!filter ||
						row.session_id.toLowerCase().includes(filter) ||
						(row.name ?? "").toLowerCase().includes(filter) ||
						row.cwd.toLowerCase().includes(filter),
				);
				if (rows.length === 0) {
					lines.push(filter ? `No archived sessions match "${filter}".` : "No archived sessions yet.");
				} else {
					lines.push("");
					for (const row of rows) {
						const when = row.archived_at ?? row.created_at;
						lines.push(
							`[${row.state}] ${row.name ?? row.session_id.slice(0, 8)} — ${row.cwd} — ${row.entry_count} entries — ${when}`,
						);
						if (row.state === "error" && row.last_error) {
							lines.push(`    error: ${row.last_error}`);
						}
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} finally {
				db.close();
			}
		},
	});

	pi.registerCommand("session-archive-other", {
		description: "Pick an inactive session and archive it",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const currentFile = ctx.sessionManager.getSessionFile();
			const sessionDir = ctx.sessionManager.getSessionDir();
			const sessions = await SessionManager.list(ctx.cwd, sessionDir);
			const candidates = sessions.filter((s) => s.path !== currentFile);
			if (candidates.length === 0) {
				ctx.ui.notify("No other sessions found for this directory.", "info");
				return;
			}
			const choices = buildSessionChoices(candidates);
			const candidatesByLabel = new Map(choices.map(({ label, session }) => [label, session]));
			const choice = await ctx.ui.select("Archive which session?", [...candidatesByLabel.keys()]);
			if (!choice) return;
			const chosen = candidatesByLabel.get(choice);
			if (!chosen) {
				ctx.ui.notify("The selected session is no longer available; reopen the picker and retry.", "warning");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Archive session?",
				`Session: ${choice}\nFrom: ${chosen.path}\n\n` +
					"The session becomes read-only, leaves the /resume list, and stays searchable. " +
					"Continue only if it is not open in another Pi process.",
			);
			if (!confirmed) return;
			const result = await archiveInactiveSession({
				deps: { dbPath, archiveRoot },
				sourcePath: chosen.path,
				currentSessionFile: currentFile,
				sessionDir,
			});
			reportResult(ctx.ui.notify.bind(ctx.ui), result);
		},
	});

	pi.registerCommand("session-archive-all", {
		description: "Archive every inactive session in this directory in one confirmed batch",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const currentFile = ctx.sessionManager.getSessionFile();
			const sessionDir = ctx.sessionManager.getSessionDir();
			const sessions = await SessionManager.list(ctx.cwd, sessionDir);
			const candidates = sessions.filter((s) => s.path !== currentFile);
			if (candidates.length === 0) {
				ctx.ui.notify("No other sessions found for this directory.", "info");
				return;
			}
			const confirmed = await ctx.ui.confirm(
				`Archive ${candidates.length} session(s)?`,
				`All ${candidates.length} inactive session(s) for ${ctx.cwd} will become read-only, ` +
					"leave the /resume list, and stay searchable. " +
					"Continue only if none of them is open in another Pi process.",
			);
			if (!confirmed) return;
			ctx.ui.notify(`Archiving ${candidates.length} session(s)…`, "info");
			const outcomes = await archiveInactiveSessions({
				deps: { dbPath, archiveRoot },
				sourcePaths: candidates.map((s) => s.path),
				currentSessionFile: currentFile,
				sessionDir,
			});
			const archived = outcomes.filter((o) => o.result.status === "archived");
			const skipped = outcomes.filter((o) => o.result.status === "rejected");
			const failed = outcomes.filter((o) => o.result.status === "failed");
			const lines = [
				`Bulk archive complete: ${archived.length} archived, ${skipped.length} skipped, ${failed.length} failed.`,
			];
			for (const group of [
				["Skipped", skipped],
				["Failed", failed],
			] as const) {
				const [label, list] = group;
				for (const outcome of list.slice(0, 5)) {
					lines.push(`${label}: ${outcome.sourcePath} — ${outcome.result.message}`);
				}
				if (list.length > 5) lines.push(`…and ${list.length - 5} more ${label.toLowerCase()}.`);
			}
			ctx.ui.notify(lines.join("\n"), failed.length > 0 ? "warning" : "info");
		},
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
				Type.String({ description: "Only entries with this role (user, assistant, toolResult, bashExecution, custom)" }),
			),
			session_id: Type.Optional(Type.String({ description: "Only entries from this archived session id" })),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100, description: "Max results (default 20, max 100)" }),
			),
		}),
		async execute(_toolCallId, params) {
			if (!fileExists(dbPath)) {
				return { content: [{ type: "text" as const, text: "No archived sessions match." }] };
			}
			const db = openArchiveDbReadOnly(dbPath);
			try {
				const hits = searchArchive(db, {
					query: params.query,
					cwd: params.cwd,
					role: params.role,
					sessionId: params.session_id,
					limit: params.limit,
				});
				if (hits.length === 0) {
					return { content: [{ type: "text" as const, text: "No archived sessions match." }] };
				}
				const text = hits
					.map(
						(h) =>
							`session ${h.session_id} entry ${h.entry_id} [${h.role ?? h.entry_type}] ${h.timestamp}\n` +
							`  session: ${h.session_name ?? "(unnamed)"} — ${h.cwd} (archived ${h.archived_at ?? "pending"})\n` +
							`  ${h.snippet}`,
					)
					.join("\n\n");
				const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 512 });
				const output = truncated.truncated
					? `${truncated.content}\n\n[Search output truncated after ${hits.length} matched rows. Refine the query or lower the limit.]`
					: truncated.content;
				return { content: [{ type: "text" as const, text: output }] };
			} finally {
				db.close();
			}
		},
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
		async execute(_toolCallId, params) {
			if (!fileExists(dbPath)) {
				throw new Error(`No archived session with id ${params.session_id}.`);
			}
			const db = openArchiveDbReadOnly(dbPath);
			try {
				const session = getSessionRow(db, params.session_id);
				if (!session || session.state !== "archived") {
					throw new Error(`No archived session with id ${params.session_id}.`);
				}
				const offset = params.offset ?? 0;
				const limit = params.limit ?? 50;
				const total = countEntries(db, params.session_id);
				const entries = readEntries(db, params.session_id, offset, limit);
				if (params.format === "raw" && !session.archive_path) {
					throw new Error(`Archived session ${params.session_id} has no JSONL artifact path.`);
				}
				const body =
					params.format === "raw"
						? readUtf8Ranges(
								session.archive_path!,
								entries.map((e) => ({ offset: e.raw_offset, length: e.raw_length })),
							).join("\n")
						: entries
								.map((e) =>
									[
										`#${e.ordinal} [${e.entry_type}${e.role ? `/${e.role}` : ""}] ${e.timestamp} (id ${e.entry_id}, parent ${e.parent_id ?? "none"})`,
										e.text_content ?? "",
									]
										.filter(Boolean)
										.join("\n"),
								)
								.join("\n\n");
				const chunks = splitUtf8Chunks(body, READ_BODY_CHUNK_BYTES);
				const chunk = params.chunk ?? 0;
				if (chunk >= chunks.length) {
					throw new Error(`Chunk ${chunk} is out of range; this page has ${chunks.length} chunk(s).`);
				}
				const range = entries.length === 0 ? "no entries" : `entries ${offset + 1}–${offset + entries.length} of ${total}`;
				const next =
					chunk + 1 < chunks.length
						? `continue with the same offset/limit and chunk ${chunk + 1}`
						: offset + entries.length < total
							? `continue with offset ${offset + entries.length} and chunk 0`
							: "end of session";
				const rawHeader =
					`Session ${session.session_id} (${session.state}) — ${session.name ?? "(unnamed)"} — ${session.cwd}\n` +
					`${range} — chunk ${chunk + 1} of ${chunks.length} — ${next}`;
				const header = truncateHead(rawHeader, { maxBytes: 4096, maxLines: 10 }).content;
				return { content: [{ type: "text" as const, text: `${header}\n\n${chunks[chunk]}` }] };
			} finally {
				db.close();
			}
		},
	});
}

const READ_BODY_CHUNK_BYTES = DEFAULT_MAX_BYTES - 8192;

function reportResult(notify: (message: string, level: "info" | "warning" | "error") => void, result: ArchiveResult) {
	switch (result.status) {
		case "archived":
			notify(result.message, "info");
			break;
		case "cancelled":
			notify(result.message, "info");
			break;
		case "rejected":
			notify(result.message, "warning");
			break;
		case "failed":
			notify(result.message, "error");
			break;
	}
}
