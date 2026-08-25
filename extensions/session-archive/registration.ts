import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, SessionManager, truncateHead } from "@earendil-works/pi-coding-agent";
import { type BoundaryValue, isString } from "../shared/validation.ts";
import { fileExists, isArchiveWriteTarget, readUtf8Ranges } from "./archive-files.ts";
import type { BulkArchiveOutcome } from "./archive-ops.ts";
import { buildSessionChoices } from "./session-choices.ts";
import { selectSessionChoices } from "./session-picker.ts";
import { createSessionsCommand } from "./sessions-command.ts";
import { splitUtf8Chunks } from "./tool-output.ts";

type Notify = (message: string, level: "info" | "warning" | "error") => void;
export type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

const READ_BODY_CHUNK_BYTES = DEFAULT_MAX_BYTES - 8192;

export function reportBatchResults(notify: Notify, outcomes: BulkArchiveOutcome[]): void {
	const archived = outcomes.filter((outcome) => outcome.result.status === "archived");
	const skipped = outcomes.filter((outcome) => outcome.result.status === "rejected");
	const failed = outcomes.filter((outcome) => outcome.result.status === "failed");
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
	notify(lines.join("\n"), failed.length > 0 ? "warning" : "info");
}

export function createWriteGuard(archiveRoot: string) {
	return async (event: ToolCallEvent, ctx: ExtensionContext) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const target = /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
			event.input as { path?: BoundaryValue }
		).path;
		if (!isString(target) || target.length === 0) return;
		if (isArchiveWriteTarget(target, ctx.cwd, archiveRoot)) {
			return {
				block: true,
				reason:
					"The session archive is read-only. Archived sessions can be searched with " +
					"search_session_archive and read with read_session_archive, but never modified.",
			};
		}
		return undefined;
	};
}

export function createArchiveCommands(deps: {
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
}) {
	const sessionArchive = async (_args: string, ctx: CommandContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionName = ctx.sessionManager.getSessionName()?.trim() || undefined;
		await deps.archiveCurrentSession({
			deps: { dbPath: deps.dbPath, archiveRoot: deps.archiveRoot },
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
	};

	const sessions = createSessionsCommand(deps);

	const sessionArchiveOther = async (_args: string, ctx: CommandContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/session-archive-other requires interactive TUI or RPC mode.", "error");
			return;
		}
		await ctx.waitForIdle();
		const currentFile = ctx.sessionManager.getSessionFile();
		const sessionDir = ctx.sessionManager.getSessionDir();
		const sessions = await SessionManager.list(ctx.cwd, sessionDir);
		const candidates = sessions.filter((s) => s.path !== currentFile);
		if (candidates.length === 0) {
			ctx.ui.notify("No other sessions found for this directory.", "info");
			return;
		}
		const selected = await selectSessionChoices(ctx, buildSessionChoices(candidates));
		if (!selected || selected.length === 0) return;
		const labels = selected.slice(0, 10).map((choice) => `  • ${choice.label}`);
		if (selected.length > labels.length) labels.push(`  …and ${selected.length - labels.length} more`);
		const confirmed = await ctx.ui.confirm(
			`Archive ${selected.length} session(s)?`,
			`${labels.join("\n")}\n\n` +
				"The selected sessions become read-only, leave the /resume list, and stay searchable. " +
				"Continue only if none is open in another Pi process.",
		);
		if (!confirmed) return;
		ctx.ui.notify(`Archiving ${selected.length} session(s)…`, "info");
		const outcomes = await deps.archiveInactiveSessions({
			deps: { dbPath: deps.dbPath, archiveRoot: deps.archiveRoot },
			sourcePaths: selected.map((choice) => choice.session.path),
			currentSessionFile: currentFile,
			sessionDir,
		});
		reportBatchResults(ctx.ui.notify.bind(ctx.ui), outcomes);
	};

	const sessionArchiveAll = async (_args: string, ctx: CommandContext) => {
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
		const outcomes = await deps.archiveInactiveSessions({
			deps: { dbPath: deps.dbPath, archiveRoot: deps.archiveRoot },
			sourcePaths: candidates.map((s) => s.path),
			currentSessionFile: currentFile,
			sessionDir,
		});
		reportBatchResults(ctx.ui.notify.bind(ctx.ui), outcomes);
	};

	return { sessionArchive, sessions, sessionArchiveOther, sessionArchiveAll };
}

export function createArchiveTools(deps: {
	dbPath: string;
	getSessionRow: typeof import("./archive-store.ts").getSessionRow;
	countEntries: typeof import("./archive-store.ts").countEntries;
	openArchiveDbReadOnly: typeof import("./archive-store.ts").openArchiveDbReadOnly;
	readEntries: typeof import("./archive-store.ts").readEntries;
	searchArchive: typeof import("./archive-store.ts").searchArchive;
}) {
	const searchSessionArchive = async (
		_toolCallId: string,
		params: { query: string; cwd?: string; role?: string; session_id?: string; limit?: number },
	) => {
		if (!fileExists(deps.dbPath)) {
			return { content: [{ type: "text" as const, text: "No archived sessions match." }], details: {} };
		}
		const db = deps.openArchiveDbReadOnly(deps.dbPath);
		try {
			const hits = deps.searchArchive(db, {
				query: params.query,
				cwd: params.cwd,
				role: params.role,
				sessionId: params.session_id,
				limit: params.limit,
			});
			if (hits.length === 0) {
				return { content: [{ type: "text" as const, text: "No archived sessions match." }], details: {} };
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
			return { content: [{ type: "text" as const, text: output }], details: {} };
		} finally {
			db.close();
		}
	};

	const readSessionArchive = async (
		_toolCallId: string,
		params: { session_id: string; offset?: number; limit?: number; format?: "normalized" | "raw"; chunk?: number },
	) => {
		if (!fileExists(deps.dbPath)) {
			throw new Error(`No archived session with id ${params.session_id}.`);
		}
		const db = deps.openArchiveDbReadOnly(deps.dbPath);
		try {
			const session = deps.getSessionRow(db, params.session_id);
			if (session?.state !== "archived") {
				throw new Error(`No archived session with id ${params.session_id}.`);
			}
			const offset = params.offset ?? 0;
			const limit = params.limit ?? 50;
			const total = deps.countEntries(db, params.session_id);
			const entries = deps.readEntries(db, params.session_id, offset, limit);
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
			const range =
				entries.length === 0 ? "no entries" : `entries ${offset + 1}–${offset + entries.length} of ${total}`;
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
			return { content: [{ type: "text" as const, text: `${header}\n\n${chunks[chunk]}` }], details: {} };
		} finally {
			db.close();
		}
	};

	return { searchSessionArchive, readSessionArchive };
}
