/**
 * Startup reconciliation for interrupted archive operations.
 * Full integrity checks are explicit so routine startup never hashes every
 * finalized archive file.
 */

import { existsSync, unlinkSync } from "node:fs";
import {
	chmodOwnerWritable,
	chmodReadOnly,
	fileStat,
	hashFile,
	pathsReferToSameFile,
	restoreFromArchive,
} from "./archive-files.ts";
import {
	type ArchivedIntegrityRow,
	finalizeArchived,
	finishRestore,
	listArchivedForIntegrity,
	listRestoreJournals,
	listSessionRows,
	markError,
	markVerified,
	openArchiveDb,
} from "./archive-store.ts";

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
	/** Restore journals completed after an interrupted restore. */
	restored: string[];
}

interface ReconcileOptions {
	dbPath: string;
	/** Absolute path of the currently active session file; never moved/deleted. */
	currentSessionFile?: string;
	/** Bound on pending rows processed per run. */
	pendingLimit?: number;
}

/**
 * Recover interrupted archives. Every branch preserves at least one complete
 * JSONL copy; the only deletion is a duplicate source whose archived bytes
 * are hash-identical, and never for the live session file.
 */
export function reconcileArchive(options: ReconcileOptions): ReconcileReport {
	const report: ReconcileReport = { finalized: [], leftPending: [], errors: [], restored: [] };
	const db = openArchiveDb(options.dbPath);
	try {
		for (const restore of listRestoreJournals(db)) {
			try {
				if (existsSync(restore.archive_path)) {
					restoreFromArchive(restore.archive_path, restore.original_path, restore.sha256, restore.file_size);
				} else if (existsSync(restore.original_path)) {
					const active = hashFile(restore.original_path);
					if (active.sha256 !== restore.sha256 || active.size !== restore.file_size)
						throw new Error("restored copy hash mismatch");
					chmodOwnerWritable(restore.original_path);
				} else throw new Error("both archive and restored copies are missing");
				finishRestore(db, restore.session_id);
				report.restored.push(restore.session_id);
			} catch (err) {
				markError(
					db,
					restore.session_id,
					`restore recovery failed: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (err as Error).message}`,
				);
				report.errors.push({
					sessionId: restore.session_id,
					message: `restore recovery failed: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (err as Error).message}`,
				});
			}
		}
		const pending = listSessionRows(db, { state: "pending", limit: options.pendingLimit ?? 50 });
		for (const row of pending) {
			reconcilePending(db, row, options.currentSessionFile, report);
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

interface IntegrityCheckEffects {
	fileStat: (path: string) => { size: number; mtimeMs: number };
	hashFile: (path: string) => { sha256: string; size: number };
	now: () => number;
}

function checkArchivedIntegrity(
	db: ReturnType<typeof openArchiveDb>,
	row: ArchivedIntegrityRow,
	integrity: ReconcileIssue[],
	effects: IntegrityCheckEffects,
): void {
	if (!row.archive_path) {
		integrity.push({ sessionId: row.session_id, message: "archived file is missing" });
		return;
	}

	let stat: { size: number; mtimeMs: number };
	try {
		stat = effects.fileStat(row.archive_path);
	} catch (err) {
		if (
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
				err as NodeJS.ErrnoException
			).code === "ENOENT" ||
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
				err as Error
			).message?.includes("ENOENT")
		) {
			integrity.push({ sessionId: row.session_id, message: "archived file is missing" });
		} else {
			integrity.push({
				sessionId: row.session_id,
				message: `archived file could not be verified: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (err as Error).message}`,
			});
		}
		return;
	}

	const mtimeMs = stat.mtimeMs;
	if (
		row.verified_at !== null &&
		stat.size === row.file_size &&
		row.verified_mtime_ms !== null &&
		mtimeMs === row.verified_mtime_ms
	) {
		return;
	}

	try {
		const actual = effects.hashFile(row.archive_path);
		if (actual.sha256 !== row.sha256) {
			integrity.push({ sessionId: row.session_id, message: "archived file content drifted (hash mismatch)" });
			return;
		}
		markVerified(db, row.session_id, effects.now(), mtimeMs);
	} catch (err) {
		integrity.push({
			sessionId: row.session_id,
			message: `archived file could not be verified: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (err as Error).message}`,
		});
	}
}

interface InspectIntegrityOptions {
	limit?: number;
	sessionId?: string;
	fileStat?: (path: string) => { size: number; mtimeMs: number };
	hashFile?: (path: string) => { sha256: string; size: number };
	now?: () => number;
}

/**
 * Inspect integrity of archived sessions for /sessions.
 * Uses a size-and-mtime fast path and records verified status for matching files.
 */
export function inspectArchiveIntegrity(dbPath: string, options: InspectIntegrityOptions = {}): ReconcileIssue[] {
	const limit = options.limit ?? 200;
	const statImpl = options.fileStat ?? fileStat;
	const hashImpl = options.hashFile ?? hashFile;
	const nowImpl = options.now ?? Date.now;

	const integrity: ReconcileIssue[] = [];
	const db = openArchiveDb(dbPath);
	try {
		for (const row of listArchivedForIntegrity(db, limit, options.sessionId)) {
			checkArchivedIntegrity(db, row, integrity, {
				fileStat: statImpl,
				hashFile: hashImpl,
				now: nowImpl,
			});
		}
	} finally {
		db.close();
	}
	return integrity;
}
