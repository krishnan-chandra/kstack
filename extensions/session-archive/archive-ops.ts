/**
 * Archive orchestration: the pending → move → finalize state machine for both
 * current-session and inactive-session archiving. This module has no Pi
 * imports; index.ts adapts real Pi contexts onto these interfaces so the
 * whole lifecycle is testable with fakes.
 */

import { readFileSync } from "node:fs";
import {
	canonicalizeActiveSource,
	archiveDestination,
	chmodReadOnly,
	moveToArchive,
	pathsReferToSameFile,
} from "./archive-files.ts";
import { parseSessionJsonlBytes, sha256Hex, type ParsedSession } from "./session-jsonl.ts";
import {
	discardPendingImport,
	finalizeArchived,
	importSessionPending,
	openArchiveDb,
} from "./archive-store.ts";

interface ArchiveDeps {
	dbPath: string;
	archiveRoot: string;
	/** Test hook for the file move (defaults to moveToArchive). */
	move?: (source: string, dest: string, sha256: string, size: number) => void;
}

export type ArchiveResult =
	| { status: "archived"; message: string }
	| { status: "cancelled"; message: string }
	| { status: "rejected"; message: string }
	| { status: "failed"; message: string };

// In-process serialization for archive mutations. BEGIN IMMEDIATE,
// busy_timeout, and uniqueness constraints serialize cross-process catalog
// operations; they cannot detect a session file open in another Pi process.
let mutationQueue: Promise<unknown> = Promise.resolve();

function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = mutationQueue.then(fn, fn);
	mutationQueue = run.catch(() => {});
	return run;
}

interface ActiveSessionSnapshot {
	/** Absolute path of the live session JSONL, undefined for ephemeral sessions. */
	sourcePath: string | undefined;
	sessionId: string;
	sessionDir: string;
	sessionName?: string;
}

export interface FreshSessionHandle {
	notify(message: string, level: "info" | "warning" | "error"): void;
}

interface ArchiveCurrentOptions {
	deps: ArchiveDeps;
	snapshot: ActiveSessionSnapshot;
	waitForIdle: () => Promise<void>;
	confirm: (title: string, message: string) => Promise<boolean>;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	/** Mirrors ctx.newSession: resolves after replacement, cancelled=true if vetoed. */
	startNewSession: (
		withSession: (fresh: FreshSessionHandle) => Promise<void>,
	) => Promise<{ cancelled: boolean }>;
}

interface StagedArchive {
	canonicalSource: string;
	destPath: string;
	sha256: string;
	size: number;
	sessionId: string;
	displayName: string;
	parsed: ParsedSession;
}

/**
 * Validate, parse, hash, and stage a session file. Returns a rejection
 * result or the staged data. Performs no mutation. When `expectedSessionId`
 * is given, the file header must match it.
 */
function stageSession(
	sourcePath: string | undefined,
	sessionDir: string,
	deps: ArchiveDeps,
	opts: { expectedSessionId?: string; sessionName?: string } = {},
): { staged: StagedArchive } | { rejected: ArchiveResult } {
	if (!sourcePath) {
		return {
			rejected: {
				status: "rejected",
				message: "This session is ephemeral (not persisted to disk); nothing to archive.",
			},
		};
	}

	let canonicalSource: string;
	try {
		canonicalSource = canonicalizeActiveSource(sourcePath, sessionDir, deps.archiveRoot);
	} catch (err) {
		return { rejected: { status: "rejected", message: (err as Error).message } };
	}

	const content = readFileSync(canonicalSource);
	let parsed: ParsedSession;
	try {
		parsed = parseSessionJsonlBytes(content);
	} catch (err) {
		return {
			rejected: {
				status: "rejected",
				message: `Refusing to archive a malformed session file: ${(err as Error).message}`,
			},
		};
	}
	if (opts.expectedSessionId && parsed.header.id !== opts.expectedSessionId) {
		return {
			rejected: {
				status: "rejected",
				message: `Session id mismatch: manager reports ${opts.expectedSessionId} but the file header says ${parsed.header.id}.`,
			},
		};
	}
	if (parsed.entries.length === 0) {
		return {
			rejected: { status: "rejected", message: "This session has no entries yet; nothing to archive." },
		};
	}

	const sessionId = parsed.header.id;
	const sha256 = sha256Hex(content);
	const destPath = archiveDestination(deps.archiveRoot, sessionId, parsed.header.timestamp);
	const displayName = opts.sessionName ?? `${sessionId.slice(0, 8)} (${parsed.entries.length} entries)`;
	return {
		staged: {
			canonicalSource,
			destPath,
			sha256,
			size: content.length,
			sessionId,
			displayName,
			parsed,
		},
	};
}

/**
 * Archive the current session: index it as pending, switch Pi to a new
 * session, then move the now-inactive file and finalize. Only plain strings
 * and numbers cross the session replacement boundary.
 */
export async function archiveCurrentSession(options: ArchiveCurrentOptions): Promise<ArchiveResult> {
	const { deps, snapshot } = options;
	await options.waitForIdle();

	const stagedOrRejected = stageSession(snapshot.sourcePath, snapshot.sessionDir, deps, {
		expectedSessionId: snapshot.sessionId,
		sessionName: snapshot.sessionName,
	});
	if ("rejected" in stagedOrRejected) {
		options.notify(stagedOrRejected.rejected.message, "warning");
		return stagedOrRejected.rejected;
	}
	const staged = stagedOrRejected.staged;

	const confirmed = await options.confirm(
		"Archive current session?",
		[
			`Session: ${staged.displayName}`,
			`From: ${staged.canonicalSource}`,
			`To: ${staged.destPath}`,
			"",
			"The session becomes read-only and leaves the /resume list. Pi will continue in a new empty session.",
		].join("\n"),
	);
	if (!confirmed) {
		const cancelled: ArchiveResult = { status: "cancelled", message: "Archive cancelled." };
		options.notify(cancelled.message, "info");
		return cancelled;
	}

	// Capture only plain values and parsed data across the session replacement below.
	const { canonicalSource, destPath, sha256, size, parsed } = staged;
	const sessionId = staged.sessionId;
	const move = deps.move ?? ((s: string, d: string, sha: string, sz: number) => moveToArchive(s, d, sha, sz));

	await withMutationLock(async () => {
		const db = openArchiveDb(deps.dbPath);
		try {
			importSessionPending(db, {
				header: parsed.header,
				entries: parsed.entries,
				originalPath: canonicalSource,
				archivePath: destPath,
				fileSize: size,
				sha256,
				name: snapshot.sessionName,
			});
		} finally {
			db.close();
		}
	});

	let finalizationError: string | undefined;
	const result = await options.startNewSession(async (fresh) => {
		try {
			await withMutationLock(async () => {
				move(canonicalSource, destPath, sha256, size);
				chmodReadOnly(destPath);
				const db = openArchiveDb(deps.dbPath);
				try {
					finalizeArchived(db, sessionId, destPath, size, sha256);
				} finally {
					db.close();
				}
			});
			fresh.notify(`Session archived: ${destPath}`, "info");
		} catch (err) {
			finalizationError = (err as Error).message;
			fresh.notify(
				`Archive finalization failed: ${finalizationError}. ` +
					"The complete session file is preserved (check both the session directory and the archive); " +
					"it is tracked as 'pending'. Pi will inspect it on startup; retry a remaining source with /session-archive-other.",
				"error",
			);
		}
	});

	if (result.cancelled) {
		await withMutationLock(async () => {
			const db = openArchiveDb(deps.dbPath);
			try {
				discardPendingImport(db, sessionId, destPath, sha256);
			} finally {
				db.close();
			}
		});
		const cancelled: ArchiveResult = {
			status: "cancelled",
			message: "Session switch was cancelled; the session is still active and no archive was created.",
		};
		options.notify(cancelled.message, "info");
		return cancelled;
	}
	if (finalizationError) {
		return {
			status: "failed",
			message: `Archive finalization failed: ${finalizationError}. The replacement session remains active and the archive is pending.`,
		};
	}
	return { status: "archived", message: `Archived ${sessionId} to ${destPath}` };
}

interface ArchiveInactiveOptions {
	deps: ArchiveDeps;
	sourcePath: string;
	/** Absolute path of the currently active session file, if any. */
	currentSessionFile?: string;
	sessionDir: string;
}

export interface BulkArchiveOutcome {
	sourcePath: string;
	result: ArchiveResult;
}

interface ArchiveInactiveBulkOptions {
	deps: ArchiveDeps;
	sourcePaths: string[];
	/** Absolute path of the currently active session file, if any. */
	currentSessionFile?: string;
	sessionDir: string;
	/** Optional progress callback invoked after each session settles. */
	onProgress?: (done: number, total: number, outcome: BulkArchiveOutcome) => void;
}

/**
 * Archive many inactive sessions sequentially. Each session runs the full
 * inactive-session state machine independently: one malformed file, live
 * session, or move failure never aborts the rest of the batch, and the
 * per-session result is reported in the returned outcomes.
 */
export async function archiveInactiveSessions(options: ArchiveInactiveBulkOptions): Promise<BulkArchiveOutcome[]> {
	const outcomes: BulkArchiveOutcome[] = [];
	const total = options.sourcePaths.length;
	for (const sourcePath of options.sourcePaths) {
		let outcome: BulkArchiveOutcome;
		try {
			const result = await archiveInactiveSession({
				deps: options.deps,
				sourcePath,
				currentSessionFile: options.currentSessionFile,
				sessionDir: options.sessionDir,
			});
			outcome = { sourcePath, result };
		} catch (err) {
			// Defense in depth: archiveInactiveSession converts known failures
			// into results, but an unexpected throw must not lose the batch.
			outcome = {
				sourcePath,
				result: { status: "failed", message: `Unexpected error: ${(err as Error).message}` },
			};
		}
		outcomes.push(outcome);
		options.onProgress?.(outcomes.length, total, outcome);
	}
	return outcomes;
}

/**
 * Archive a session that is not currently loaded in Pi. Revalidates the
 * selected path immediately before mutation because picker metadata is stale.
 */
export async function archiveInactiveSession(options: ArchiveInactiveOptions): Promise<ArchiveResult> {
	const { deps } = options;

	return withMutationLock(async () => {
		// Revalidate inside the lock: the selection may be stale.
		const stagedOrRejected = stageSession(options.sourcePath, options.sessionDir, deps);
		if ("rejected" in stagedOrRejected) return stagedOrRejected.rejected;
		const staged = stagedOrRejected.staged;
		if (
			options.currentSessionFile &&
			pathsReferToSameFile(staged.canonicalSource, options.currentSessionFile)
		) {
			return {
				status: "rejected",
				message: "Refusing to archive the currently active session here; use /session-archive instead.",
			};
		}
		const parsed = staged.parsed;

		const db = openArchiveDb(deps.dbPath);
		try {
			const imported = importSessionPending(db, {
				header: parsed.header,
				entries: parsed.entries,
				originalPath: staged.canonicalSource,
				archivePath: staged.destPath,
				fileSize: staged.size,
				sha256: staged.sha256,
			});
			if (imported === "already-archived") {
				return { status: "rejected", message: `Session ${parsed.header.id} is already archived.` };
			}
		} finally {
			db.close();
		}

		const move = deps.move ?? ((s: string, d: string, sha: string, sz: number) => moveToArchive(s, d, sha, sz));
		try {
			move(staged.canonicalSource, staged.destPath, staged.sha256, staged.size);
			chmodReadOnly(staged.destPath);
			const db = openArchiveDb(deps.dbPath);
			try {
				finalizeArchived(db, parsed.header.id, staged.destPath, staged.size, staged.sha256);
			} finally {
				db.close();
			}
		} catch (err) {
			return {
				status: "failed",
				message:
					`Archive finalization failed: ${(err as Error).message}. ` +
					"A complete copy of the session is preserved and tracked as 'pending'. " +
					"Pi will inspect it on startup; retry the remaining source with /session-archive-other.",
			};
		}
		return {
			status: "archived",
			message: `Archived ${parsed.header.id} to ${staged.destPath}`,
		};
	});
}
