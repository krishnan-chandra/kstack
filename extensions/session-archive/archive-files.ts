/**
 * Archive filesystem layout, source canonicalization, and crash-safe file
 * movement (atomic rename with a verified copy fallback for EXDEV).
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "../shared/kstack-config.ts";
import { sha256Hex } from "./session-jsonl.ts";

export class ArchiveFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveFileError";
	}
}

export function getArchiveRoot(env?: NodeJS.ProcessEnv): string {
	return join(getAgentDir(env), "archive");
}

export function getArchiveDbPath(archiveRoot: string): string {
	return join(archiveRoot, "archive.sqlite3");
}

export function ensureArchiveDirs(archiveRoot: string): void {
	mkdirSync(join(archiveRoot, "sessions"), { recursive: true, mode: 0o700 });
	try {
		chmodSync(archiveRoot, 0o700);
		chmodSync(join(archiveRoot, "sessions"), 0o700);
	} catch {
		// Best effort on platforms without POSIX modes.
	}
}

const SAFE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateSessionId(sessionId: string): void {
	if (!SAFE_SESSION_ID.test(sessionId)) {
		throw new ArchiveFileError(`session id is not safe for use in a path: ${JSON.stringify(sessionId)}`);
	}
}

/** archive/sessions/YYYY/MM/<session-uuid>/session.jsonl from the header timestamp (UTC). */
export function archiveDestination(archiveRoot: string, sessionId: string, createdAtIso: string): string {
	validateSessionId(sessionId);
	const date = new Date(createdAtIso);
	if (Number.isNaN(date.getTime())) {
		throw new ArchiveFileError(`invalid session timestamp: ${JSON.stringify(createdAtIso)}`);
	}
	const year = String(date.getUTCFullYear());
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	return join(archiveRoot, "sessions", year, month, sessionId, "session.jsonl");
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isPathInside(child: string, parent: string): boolean {
	const c = resolve(child);
	const p = resolve(parent);
	if (c === p) return true;
	const parentWithSep = p.endsWith(sep) ? p : p + sep;
	return c.startsWith(parentWithSep);
}

/**
 * Prove the source is a regular, non-symlink .jsonl file inside the active
 * session directory and outside the archive root. Returns the canonical path.
 */
export function canonicalizeActiveSource(sourcePath: string, activeSessionDir: string, archiveRoot: string): string {
	if (!isAbsolute(sourcePath)) {
		throw new ArchiveFileError(`session file path is not absolute: ${sourcePath}`);
	}
	if (!sourcePath.endsWith(".jsonl")) {
		throw new ArchiveFileError(`session file must end in .jsonl: ${sourcePath}`);
	}
	const lst = lstatSync(sourcePath, { throwIfNoEntry: false });
	if (!lst) {
		throw new ArchiveFileError(`session file does not exist: ${sourcePath}`);
	}
	if (lst.isSymbolicLink()) {
		throw new ArchiveFileError(`refusing to archive a symlinked session file: ${sourcePath}`);
	}
	if (!lst.isFile()) {
		throw new ArchiveFileError(`session path is not a regular file: ${sourcePath}`);
	}
	const canonical = realpathSync(sourcePath);
	const canonicalArchiveRoot = existsSync(archiveRoot) ? realpathSync(archiveRoot) : resolve(archiveRoot);
	if (isPathInside(canonical, canonicalArchiveRoot)) {
		throw new ArchiveFileError(`session file ${canonical} is already inside the archive root`);
	}
	const canonicalSessionDir = realpathSync(activeSessionDir);
	if (!isPathInside(canonical, canonicalSessionDir)) {
		throw new ArchiveFileError(
			`session file ${canonical} is outside the active session directory ${canonicalSessionDir}`,
		);
	}
	return canonical;
}

export function hashFile(path: string): { sha256: string; size: number } {
	const buf = readFileSync(path);
	return { sha256: sha256Hex(buf), size: buf.length };
}

/** Compare existing paths by canonical name and filesystem identity. */
export function pathsReferToSameFile(left: string, right: string): boolean {
	try {
		const leftReal = realpathSync(left);
		const rightReal = realpathSync(right);
		if (leftReal === rightReal) return true;
		const leftStat = statSync(leftReal);
		const rightStat = statSync(rightReal);
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

function assertExpectedFile(path: string, expectedSha256: string, expectedSize: number): void {
	const actual = hashFile(path);
	if (actual.sha256 !== expectedSha256 || actual.size !== expectedSize) {
		throw new ArchiveFileError(
			`session file ${path} changed after it was staged; refusing to archive stale indexed content`,
		);
	}
}

/**
 * Move `sourcePath` to `destPath` without ever losing the only complete copy.
 * Prefers an atomic same-filesystem rename; on EXDEV copies to a temp file in
 * the destination directory, fsyncs, verifies size+SHA-256, atomically renames
 * the temp into place, then unlinks the source. If the destination already
 * exists it is only accepted when its hash matches; a hash mismatch is a hard
 * collision error and nothing is overwritten.
 */
export function moveToArchive(
	sourcePath: string,
	destPath: string,
	expectedSha256: string,
	expectedSize: number,
	renameImpl: (source: string, dest: string) => void = renameSync,
): void {
	mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
	assertExpectedFile(sourcePath, expectedSha256, expectedSize);

	if (existsSync(destPath)) {
		const dest = hashFile(destPath);
		if (dest.sha256 !== expectedSha256 || dest.size !== expectedSize) {
			throw new ArchiveFileError(
				`archive destination ${destPath} already exists with different content; refusing to overwrite`,
			);
		}
		// Recheck before deletion: session shutdown or another Pi process may
		// have appended after the initial staging read.
		assertExpectedFile(sourcePath, expectedSha256, expectedSize);
		unlinkSync(sourcePath);
		return;
	}

	try {
		renameImpl(sourcePath, destPath);
		try {
			assertExpectedFile(destPath, expectedSha256, expectedSize);
		} catch (err) {
			// Best effort rollback keeps a changed session discoverable in its
			// active directory. If rollback fails, the complete copy remains at
			// the destination and the pending row allows manual recovery.
			try {
				renameSync(destPath, sourcePath);
			} catch {
				// Preserve the destination rather than risking deletion.
			}
			throw err;
		}
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
	}

	// Cross-filesystem fallback: verified copy, then unlink.
	const tempPath = join(dirname(destPath), `.session-${randomBytes(6).toString("hex")}.tmp`);
	try {
		copyFileSync(sourcePath, tempPath);
		const fd = openSync(tempPath, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		assertExpectedFile(tempPath, expectedSha256, expectedSize);
		// Never unlink a source that changed while it was being copied.
		assertExpectedFile(sourcePath, expectedSha256, expectedSize);
		renameSync(tempPath, destPath);
		unlinkSync(sourcePath);
	} catch (err) {
		try {
			unlinkSync(tempPath);
		} catch {
			// Temp may not exist; nothing to clean.
		}
		throw err;
	}
}

/** Set the archived JSONL read-only where POSIX permissions exist. */
/** Move an archived file back to its recorded active location without overwriting different bytes. */
export function restoreFromArchive(
	sourcePath: string,
	destPath: string,
	expectedSha256: string,
	expectedSize: number,
	renameImpl: (source: string, dest: string) => void = renameSync,
): void {
	assertExpectedFile(sourcePath, expectedSha256, expectedSize);
	mkdirSync(dirname(destPath), { recursive: true, mode: 0o700 });
	if (existsSync(destPath)) {
		assertExpectedFile(destPath, expectedSha256, expectedSize);
		// A verified duplicate means a previous restore completed its file move.
		assertExpectedFile(sourcePath, expectedSha256, expectedSize);
		unlinkSync(sourcePath);
	} else {
		try {
			renameImpl(sourcePath, destPath);
			assertExpectedFile(destPath, expectedSha256, expectedSize);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
			const tempPath = join(dirname(destPath), `.restore-${randomBytes(6).toString("hex")}.tmp`);
			try {
				copyFileSync(sourcePath, tempPath);
				const fd = openSync(tempPath, "r");
				try {
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				assertExpectedFile(tempPath, expectedSha256, expectedSize);
				assertExpectedFile(sourcePath, expectedSha256, expectedSize);
				renameSync(tempPath, destPath);
				unlinkSync(sourcePath);
			} catch (copyError) {
				try {
					unlinkSync(tempPath);
				} catch {
					/* best effort */
				}
				throw copyError;
			}
		}
	}
	try {
		chmodSync(destPath, 0o600);
	} catch (err) {
		if (process.platform !== "win32")
			throw new ArchiveFileError(`failed to make restored session writable: ${(err as Error).message}`);
	}
}

export function chmodReadOnly(path: string): void {
	try {
		chmodSync(path, 0o444);
	} catch (err) {
		if (process.platform === "win32") return;
		throw new ArchiveFileError(`failed to mark ${path} read-only: ${(err as Error).message}`);
	}
}

export function fileExists(path: string): boolean {
	return existsSync(path);
}

export function fileSize(path: string): number {
	return statSync(path).size;
}

export function fileStat(path: string): { size: number; mtimeMs: number } {
	const stat = statSync(path);
	return { size: stat.size, mtimeMs: stat.mtimeMs };
}

interface FileByteRange {
	offset: number;
	length: number;
}

/** Read exact UTF-8 byte ranges from the canonical archived JSONL artifact. */
export function readUtf8Ranges(path: string, ranges: FileByteRange[]): string[] {
	const fd = openSync(path, "r");
	try {
		return ranges.map(({ offset, length }) => {
			if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
				throw new ArchiveFileError(`invalid byte range ${offset}+${length} for ${path}`);
			}
			const bytes = Buffer.alloc(length);
			let filled = 0;
			while (filled < length) {
				const count = readSync(fd, bytes, filled, length - filled, offset + filled);
				if (count === 0) {
					throw new ArchiveFileError(`archived session ${path} ended inside byte range ${offset}+${length}`);
				}
				filled += count;
			}
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				throw new ArchiveFileError(`archived session ${path} contains invalid UTF-8 at byte offset ${offset}`);
			}
		});
	} finally {
		closeSync(fd);
	}
}

/**
 * Decide whether a write/edit target lands inside the archive root. Resolves
 * relative paths against cwd and follows symlinks when the target exists so
 * symlink aliases of the archive cannot be written through.
 */
export function isArchiveWriteTarget(targetPath: string, cwd: string, archiveRoot: string): boolean {
	const absolute = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);
	const canonical = resolveThroughExistingAncestor(absolute);
	const canonicalRoot = resolveThroughExistingAncestor(resolve(archiveRoot));
	return isPathInside(canonical, canonicalRoot) || isPathInside(absolute, resolve(archiveRoot));
}

function resolveThroughExistingAncestor(path: string): string {
	let cursor = resolve(path);
	const suffix: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) return resolve(path);
		suffix.unshift(basename(cursor));
		cursor = parent;
	}
	try {
		return resolve(realpathSync(cursor), ...suffix);
	} catch {
		return resolve(path);
	}
}
