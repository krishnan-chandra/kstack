/**
 * Startup reconciliation and integrity checks for the archive state machine.
 * Recovers interrupted archive operations and surfaces drift, without ever
 * touching the currently active session file.
 */

import { existsSync, unlinkSync } from "node:fs";
import { chmodReadOnly, hashFile, pathsReferToSameFile } from "./archive-files.ts";
import { finalizeArchived, listSessionRows, markError, openArchiveDb } from "./archive-store.ts";

interface ReconcileIssue {
	sessionId: string;
	message: string;
}

interface ReconcileReport {
	/** Pending rows successfully finalized to 'archived'. */
	finalized: string[];
	/** Pending rows left in place for an explicit retry (e.g. live session). */
	leftPending: ReconcileIssue[];
	/** Pending rows marked 'error' (unrecoverable without user action). */
	errors: ReconcileIssue[];
	/** Archived rows whose file is missing or drifted. */
	integrity: ReconcileIssue[];
}

interface ReconcileOptions {
	dbPath: string;
	/** Absolute path of the currently active session file; never moved/deleted. */
	currentSessionFile?: string;
	/** Bound on pending rows processed per run. */
	pendingLimit?: number;
	/** Bound on archived rows integrity-checked per run. */
	archivedLimit?: number;
}

/**
 * Recover interrupted archives. Every branch preserves at least one complete
 * JSONL copy; the only deletion is a duplicate source whose archived bytes
 * are hash-identical, and never for the live session file.
 */
export function reconcileArchive(options: ReconcileOptions): ReconcileReport {
	const report: ReconcileReport = { finalized: [], leftPending: [], errors: [], integrity: [] };
	const db = openArchiveDb(options.dbPath);
	try {
		const pending = listSessionRows(db, { state: "pending", limit: options.pendingLimit ?? 50 });
		for (const row of pending) {
			reconcilePending(db, row, options.currentSessionFile, report);
		}

		const archived = listSessionRows(db, { state: "archived", limit: options.archivedLimit ?? 200 });
		for (const row of archived) {
			checkArchivedIntegrity(row, report);
		}
	} finally {
		db.close();
	}
	return report;
}

interface PendingRow {
	session_id: string;
	original_path: string;
	archive_path: string | null;
	sha256: string;
	file_size: number;
}

function reconcilePending(
	db: ReturnType<typeof openArchiveDb>,
	row: PendingRow,
	currentSessionFile: string | undefined,
	report: ReconcileReport,
): void {
	const source = row.original_path;
	if (!row.archive_path) {
		markError(db, row.session_id, "pending row has no recorded archive destination");
		report.errors.push({ sessionId: row.session_id, message: "no recorded archive destination" });
		return;
	}
	const dest = row.archive_path;
	const sourceExists = existsSync(source);
	const destExists = existsSync(dest);

	if (!sourceExists && !destExists) {
		markError(db, row.session_id, "both source and archive copy are missing");
		report.errors.push({ sessionId: row.session_id, message: "source and archive copy both missing" });
		return;
	}

	if (destExists) {
		const destHash = hashFile(dest);
		if (destHash.sha256 !== row.sha256) {
			markError(db, row.session_id, `archive copy at ${dest} failed hash verification`);
			report.errors.push({ sessionId: row.session_id, message: "archive copy hash mismatch; files preserved" });
			return;
		}
		if (sourceExists) {
			const sourceHash = hashFile(source);
			if (sourceHash.sha256 !== row.sha256) {
				markError(db, row.session_id, "source and archive copies differ; both preserved");
				report.errors.push({ sessionId: row.session_id, message: "source/archive hash mismatch; both preserved" });
				return;
			}
			if (currentSessionFile && pathsReferToSameFile(source, currentSessionFile)) {
				// Never touch the live session file; an explicit /session-archive finishes this.
				report.leftPending.push({
					sessionId: row.session_id,
					message: "source is the currently active session; run /session-archive to finish",
				});
				return;
			}
			unlinkSync(source);
		}
		chmodReadOnly(dest);
		finalizeArchived(db, row.session_id, dest, row.file_size, row.sha256);
		report.finalized.push(row.session_id);
		return;
	}

	// Destination absent, source present: the move never happened. Leave the
	// session active; the user can retry explicitly.
	report.leftPending.push({
		sessionId: row.session_id,
		message: "archive move did not complete; retry with /session-archive or /session-archive-other",
	});
}

interface ArchivedRow {
	session_id: string;
	archive_path: string | null;
	sha256: string;
}

function checkArchivedIntegrity(row: ArchivedRow, report: ReconcileReport): void {
	if (!row.archive_path || !existsSync(row.archive_path)) {
		report.integrity.push({ sessionId: row.session_id, message: "archived file is missing" });
		return;
	}
	try {
		const actual = hashFile(row.archive_path);
		if (actual.sha256 !== row.sha256) {
			report.integrity.push({ sessionId: row.session_id, message: "archived file content drifted (hash mismatch)" });
		}
	} catch (err) {
		report.integrity.push({
			sessionId: row.session_id,
			message: `archived file could not be verified: ${(err as Error).message}`,
		});
	}
}

/** Read-only integrity inspection for /session-archives. */
export function inspectArchiveIntegrity(dbPath: string, limit = 200): ReconcileIssue[] {
	const report: ReconcileReport = { finalized: [], leftPending: [], errors: [], integrity: [] };
	const db = openArchiveDb(dbPath);
	try {
		for (const row of listSessionRows(db, { state: "archived", limit })) {
			checkArchivedIntegrity(row, report);
		}
	} finally {
		db.close();
	}
	return report.integrity;
}
