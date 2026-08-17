/** Advisory per-repository file lock for stack publication.
 *
 * The lock payload is written to a unique candidate before an atomic hard-link
 * creates the public lock path. Contenders therefore never observe a
 * half-written lock. A short-lived reaper lock serializes dead/corrupt lock
 * reclamation so two contenders cannot both replace the same stale lock.
 */

import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./kstack-config.ts";

const DEFAULT_CORRUPT_STALE_AFTER_MS = 60 * 60 * 1000;

interface PublicationLock {
	release(): void;
}

export type LockAttempt =
	| { ok: true; lock: PublicationLock }
	| { ok: false; holder: { pid: number; startedAt: string } | undefined };

interface LockDeps {
	repositoryPath: string;
	locksDir?: string;
	pid?: number;
	isPidAlive?: (pid: number) => boolean;
	now?: () => Date;
	staleAfterMs?: number;
}

interface OwnerPayload {
	pid: number;
	startedAt: string;
	repositoryPath: string;
	ownerToken: string;
}

type ExistingLock =
	| { kind: "missing" }
	| { kind: "unsafe" }
	| { kind: "corrupt"; modifiedAtMs: number }
	| { kind: "valid"; owner: OwnerPayload };

function lockFileName(repositoryPath: string): string {
	const hash = createHash("sha256").update(repositoryPath).digest("hex");
	return `publish-${hash}.json`;
}

function errorCode(error: unknown): unknown {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return error.code;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM means the process exists but cannot be signalled. Only ESRCH
		// proves that the pid has no process.
		return errorCode(error) !== "ESRCH";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOwner(raw: string, repositoryPath: string): OwnerPayload | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return undefined;
		if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return undefined;
		if (typeof parsed.startedAt !== "string" || !Number.isFinite(Date.parse(parsed.startedAt))) return undefined;
		if (parsed.repositoryPath !== repositoryPath) return undefined;
		if (typeof parsed.ownerToken !== "string" || parsed.ownerToken.length === 0) return undefined;
		return {
			pid: parsed.pid,
			startedAt: parsed.startedAt,
			repositoryPath: parsed.repositoryPath,
			ownerToken: parsed.ownerToken,
		};
	} catch {
		return undefined;
	}
}

function inspectExisting(lockPath: string, repositoryPath: string): ExistingLock {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(lockPath);
	} catch (error: unknown) {
		return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "unsafe" };
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "unsafe" };
	try {
		const owner = parseOwner(readFileSync(lockPath, "utf8"), repositoryPath);
		return owner ? { kind: "valid", owner } : { kind: "corrupt", modifiedAtMs: stat.mtimeMs };
	} catch (error: unknown) {
		return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "unsafe" };
	}
}

function tryAtomicCreate(lockPath: string, payload: OwnerPayload): PublicationLock | undefined {
	const candidatePath = `${lockPath}.${payload.pid}.${payload.ownerToken}.candidate`;
	try {
		writeFileSync(candidatePath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
		try {
			linkSync(candidatePath, lockPath);
		} catch (error: unknown) {
			if (errorCode(error) === "EEXIST") return undefined;
			throw error;
		}
		return {
			release() {
				const existing = inspectExisting(lockPath, payload.repositoryPath);
				if (existing.kind !== "valid" || existing.owner.ownerToken !== payload.ownerToken) return;
				try {
					unlinkSync(lockPath);
				} catch {}
			},
		};
	} finally {
		try {
			unlinkSync(candidatePath);
		} catch {}
	}
}

function blocked(existing: ExistingLock): Extract<LockAttempt, { ok: false }> {
	return {
		ok: false,
		holder: existing.kind === "valid" ? { pid: existing.owner.pid, startedAt: existing.owner.startedAt } : undefined,
	};
}

function isReclaimable(
	existing: ExistingLock,
	isPidAlive: (pid: number) => boolean,
	nowMs: number,
	corruptStaleAfterMs: number,
): boolean {
	if (existing.kind === "valid") return !isPidAlive(existing.owner.pid);
	if (existing.kind === "corrupt") return nowMs - existing.modifiedAtMs >= corruptStaleAfterMs;
	return false;
}

function retryCreate(lockPath: string, payload: OwnerPayload): LockAttempt {
	const lock = tryAtomicCreate(lockPath, payload);
	return lock ? { ok: true, lock } : { ok: false, holder: undefined };
}

export function acquirePublicationLock(deps: LockDeps): LockAttempt {
	const locksDir = deps.locksDir ?? join(getAgentDir(), "kstack-locks");
	const pid = deps.pid ?? process.pid;
	const now = deps.now ?? (() => new Date());
	const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
	const corruptStaleAfterMs = deps.staleAfterMs ?? DEFAULT_CORRUPT_STALE_AFTER_MS;
	const repositoryPath = deps.repositoryPath;
	const acquiredAt = now();

	mkdirSync(locksDir, { recursive: true, mode: 0o700 });

	const lockPath = join(locksDir, lockFileName(repositoryPath));
	const payload: OwnerPayload = {
		pid,
		startedAt: acquiredAt.toISOString(),
		repositoryPath,
		ownerToken: randomUUID(),
	};
	const lock = tryAtomicCreate(lockPath, payload);
	if (lock) return { ok: true, lock };

	const first = inspectExisting(lockPath, repositoryPath);
	if (first.kind === "missing") return retryCreate(lockPath, payload);
	if (!isReclaimable(first, isPidAlive, acquiredAt.getTime(), corruptStaleAfterMs)) return blocked(first);

	// Only one process may decide that an existing lock is stale and remove it.
	// An abandoned reaper lock is conservative: normal acquisition still works
	// once the publication lock disappears, but stale cleanup may need manual help.
	const reaperPath = `${lockPath}.reaper`;
	const reaperPayload: OwnerPayload = { ...payload, repositoryPath: `${repositoryPath}#reaper` };
	const reaper = tryAtomicCreate(reaperPath, reaperPayload);
	if (!reaper) return blocked(first);

	try {
		const current = inspectExisting(lockPath, repositoryPath);
		if (current.kind === "missing") return retryCreate(lockPath, payload);
		if (!isReclaimable(current, isPidAlive, acquiredAt.getTime(), corruptStaleAfterMs)) return blocked(current);
		try {
			unlinkSync(lockPath);
		} catch {
			return blocked(current);
		}
		const retry = tryAtomicCreate(lockPath, payload);
		return retry ? { ok: true, lock: retry } : blocked(current);
	} finally {
		reaper.release();
	}
}
