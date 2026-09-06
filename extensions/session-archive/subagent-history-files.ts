/** Bounded, read-only discovery and stable reads for retained child sessions. */
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { classifySubagentLeaseReadOnly, getSubagentSessionsRoot } from "../shared/subagent-sessions.ts";
import { type BoundaryValue, isObject, isString } from "../shared/validation.ts";
import { type ParsedSession, parseSessionJsonlBytes } from "./session-jsonl.ts";

const SUBAGENT_HISTORY_DIRECTORY_LIMIT = 5_000;
export const SUBAGENT_HISTORY_SESSION_BYTES = 32 * 1024 * 1024;
const LEASE_BYTES = 64 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;
const SESSION_FILE =
	/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface SubagentFileSignature {
	size: number;
	mtimeMs: number;
	inode: number;
}

export interface SubagentHistoryFile {
	sessionId: string;
	filename: string;
	path: string;
	signature: SubagentFileSignature;
	filenameTimestampMs: number;
}

export interface SubagentHistorySkip {
	sessionId?: string;
	filename?: string;
	reason: string;
	retryable: boolean;
}

export interface SubagentHistoryInventory {
	root: string;
	complete: boolean;
	inspectedEntries: number;
	files: SubagentHistoryFile[];
	activeSessionIds: string[];
	skipped: SubagentHistorySkip[];
}

export type SubagentFileCheck =
	| { kind: "eligible" }
	| { kind: "active"; reason: string }
	| { kind: "changed"; reason: string }
	| { kind: "unavailable"; reason: string }
	| { kind: "invalid"; reason: string };

export type StableSubagentRead =
	| {
			kind: "read";
			file: SubagentHistoryFile;
			bytes: Uint8Array;
			parsed: ParsedSession;
			name: string | null;
	  }
	| Exclude<SubagentFileCheck, { kind: "eligible" }>;

type StableSubagentRangeRead = { kind: "read"; ranges: string[] } | Exclude<SubagentFileCheck, { kind: "eligible" }>;

interface FileOptions {
	root?: string;
	now?: () => number;
	isPidAlive?: (pid: number) => boolean;
	directoryLimit?: number;
	maxSessionBytes?: number;
	signal?: AbortSignal;
}

interface DiscoverOptions extends FileOptions {
	/**
	 * When set, only this session's lease is classified. Other candidates are listed
	 * for signature comparison without an eligibility claim; callers must revalidate
	 * any file they read. Exact reads use this to avoid classifying every lease.
	 */
	leaseCheckSessionId?: string;
}

function errorCode(error: BoundaryValue): string | undefined {
	if (!isObject(error) || error === null || !("code" in error)) return undefined;
	return isString(error.code) ? error.code : undefined;
}

function boundedReason(error: BoundaryValue): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replaceAll(/\s+/g, " ").slice(0, 300);
}

function signature(stat: { size: number; mtimeMs: number; ino: number }): SubagentFileSignature {
	return { size: stat.size, mtimeMs: stat.mtimeMs, inode: stat.ino };
}

export function sameSubagentFileSignature(left: SubagentFileSignature, right: SubagentFileSignature): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs && left.inode === right.inode;
}

function parseFilename(name: string): { sessionId: string; timestampMs: number } | undefined {
	const match = SESSION_FILE.exec(name);
	if (!match) return undefined;
	const timestamp = match[1].replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");
	const timestampMs = Date.parse(timestamp);
	if (!Number.isFinite(timestampMs)) return undefined;
	return { sessionId: match[2].toLowerCase(), timestampMs };
}

async function safeRoot(root: string): Promise<string | undefined> {
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(root);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("subagent history root is not a direct directory");
	return realpath(root);
}

function containedDirectChild(path: string, root: string, rootCanonical: string, canonical: string): boolean {
	return dirname(resolve(path)) === resolve(root) && dirname(canonical) === rootCanonical;
}

async function readBoundedHandle(
	path: string,
	size: number,
	signal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; before: SubagentFileSignature; after: SubagentFileSignature }> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const beforeStat = await handle.stat();
		const before = signature(beforeStat);
		if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) throw new Error("source is not a regular file");
		if (before.size !== size) throw new Error("source size changed before read");
		const bytes = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			signal?.throwIfAborted();
			const length = Math.min(READ_BLOCK_BYTES, size - offset);
			const result = await handle.read(bytes, offset, length, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset !== size) throw new Error("source was truncated during read");
		const after = signature(await handle.stat());
		return { bytes, before, after };
	} finally {
		await handle.close();
	}
}

type LeaseCheck = { kind: "active"; reason: string } | { kind: "inactive" };

async function classifyLease(options: {
	root: string;
	rootCanonical: string;
	sessionId: string;
	nowMs: number;
	isPidAlive?: (pid: number) => boolean;
	signal?: AbortSignal;
}): Promise<LeaseCheck> {
	const activeRoot = join(options.root, ".active");
	let activeRootStat: Awaited<ReturnType<typeof lstat>>;
	try {
		activeRootStat = await lstat(activeRoot);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "inactive" };
		return { kind: "active", reason: "lease directory is unreadable" };
	}
	if (!activeRootStat.isDirectory() || activeRootStat.isSymbolicLink()) {
		return { kind: "active", reason: "lease directory identity is uncertain" };
	}
	try {
		const activeCanonical = await realpath(activeRoot);
		if (activeCanonical !== join(options.rootCanonical, ".active")) {
			return { kind: "active", reason: "lease directory escapes the retained-session root" };
		}
	} catch {
		return { kind: "active", reason: "lease directory cannot be resolved safely" };
	}

	const leasePath = join(activeRoot, `${options.sessionId}.json`);
	let leaseStat: Awaited<ReturnType<typeof lstat>>;
	try {
		leaseStat = await lstat(leasePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "inactive" };
		return { kind: "active", reason: "lease state is unreadable" };
	}
	if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || leaseStat.size > LEASE_BYTES) {
		return { kind: "active", reason: "lease identity is uncertain" };
	}
	try {
		options.signal?.throwIfAborted();
		const read = await readBoundedHandle(leasePath, leaseStat.size, options.signal);
		const pathStat = await lstat(leasePath);
		const current = signature(pathStat);
		if (
			!sameSubagentFileSignature(read.before, read.after) ||
			!sameSubagentFileSignature(read.after, current) ||
			pathStat.isSymbolicLink()
		) {
			return { kind: "active", reason: "lease changed while it was inspected" };
		}
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
		const classification = classifySubagentLeaseReadOnly({
			raw,
			mtimeMs: leaseStat.mtimeMs,
			nowMs: options.nowMs,
			isPidAlive: options.isPidAlive,
		});
		return classification.kind === "active" ? { kind: "active", reason: classification.reason } : { kind: "inactive" };
	} catch (error) {
		if (options.signal?.aborted) options.signal.throwIfAborted();
		return { kind: "active", reason: `lease state is uncertain: ${boundedReason(error)}` };
	}
}

export async function discoverSubagentHistory(options: DiscoverOptions = {}): Promise<SubagentHistoryInventory> {
	const root = resolve(options.root ?? getSubagentSessionsRoot());
	const limit = options.directoryLimit ?? SUBAGENT_HISTORY_DIRECTORY_LIMIT;
	const inventory: SubagentHistoryInventory = {
		root,
		complete: true,
		inspectedEntries: 0,
		files: [],
		activeSessionIds: [],
		skipped: [],
	};
	let checkedRoot: Awaited<ReturnType<typeof safeRoot>>;
	try {
		checkedRoot = await safeRoot(root);
	} catch (error) {
		return {
			...inventory,
			complete: false,
			skipped: [{ reason: `retained-session root is unsafe: ${boundedReason(error)}`, retryable: false }],
		};
	}
	if (!checkedRoot) return inventory;
	const candidates: SubagentHistoryFile[] = [];
	let directory: Awaited<ReturnType<typeof opendir>> | undefined;
	try {
		directory = await opendir(root);
		for await (const entry of directory) {
			options.signal?.throwIfAborted();
			if (inventory.inspectedEntries >= limit) {
				inventory.complete = false;
				break;
			}
			inventory.inspectedEntries++;
			if (!entry.name.endsWith(".jsonl")) continue;
			const parsedName = parseFilename(entry.name);
			if (!parsedName) {
				inventory.skipped.push({
					filename: entry.name,
					reason: "filename has no valid timestamp and UUID",
					retryable: false,
				});
				continue;
			}
			const path = join(root, entry.name);
			try {
				const stat = await lstat(path);
				if (!stat.isFile() || stat.isSymbolicLink()) {
					inventory.skipped.push({
						sessionId: parsedName.sessionId,
						filename: entry.name,
						reason: "source is not a direct regular non-symlink file",
						retryable: false,
					});
					continue;
				}
				const canonical = await realpath(path);
				if (!containedDirectChild(path, root, checkedRoot, canonical)) {
					inventory.skipped.push({
						sessionId: parsedName.sessionId,
						filename: entry.name,
						reason: "source path escapes the retained-session root",
						retryable: false,
					});
					continue;
				}
				candidates.push({
					sessionId: parsedName.sessionId,
					filename: entry.name,
					path,
					signature: signature(stat),
					filenameTimestampMs: parsedName.timestampMs,
				});
			} catch (error) {
				inventory.skipped.push({
					sessionId: parsedName.sessionId,
					filename: entry.name,
					reason: `source could not be inspected safely: ${boundedReason(error)}`,
					retryable: true,
				});
			}
		}
	} catch (error) {
		inventory.complete = false;
		inventory.skipped.push({
			reason: `retained-session directory could not be enumerated: ${boundedReason(error)}`,
			retryable: true,
		});
	} finally {
		try {
			await directory?.close();
		} catch (error) {
			// A completed or broken async iterator closes the directory itself.
			if (errorCode(error) !== "ERR_DIR_CLOSED") inventory.complete = false;
		}
	}

	const byId = new Map<string, SubagentHistoryFile[]>();
	for (const candidate of candidates) {
		const list = byId.get(candidate.sessionId);
		if (list) list.push(candidate);
		else byId.set(candidate.sessionId, [candidate]);
	}
	const nowMs = (options.now ?? Date.now)();
	for (const [sessionId, matches] of byId) {
		if (matches.length !== 1) {
			for (const match of matches) {
				inventory.skipped.push({
					sessionId,
					filename: match.filename,
					reason: `duplicate retained filenames claim session ${sessionId}`,
					retryable: false,
				});
			}
			continue;
		}
		const candidate = matches[0];
		if (options.leaseCheckSessionId !== undefined && options.leaseCheckSessionId !== sessionId) {
			inventory.files.push(candidate);
			continue;
		}
		const lease = await classifyLease({
			root,
			rootCanonical: checkedRoot,
			sessionId,
			nowMs,
			isPidAlive: options.isPidAlive,
			signal: options.signal,
		});
		if (lease.kind === "active") inventory.activeSessionIds.push(sessionId);
		else inventory.files.push(candidate);
	}
	inventory.files.sort(
		(left, right) =>
			right.filenameTimestampMs - left.filenameTimestampMs || left.filename.localeCompare(right.filename),
	);
	inventory.activeSessionIds.sort();
	return inventory;
}

export async function revalidateSubagentHistoryFile(
	file: SubagentHistoryFile,
	options: FileOptions = {},
): Promise<SubagentFileCheck> {
	options.signal?.throwIfAborted();
	const root = resolve(options.root ?? getSubagentSessionsRoot());
	let checkedRoot: Awaited<ReturnType<typeof safeRoot>>;
	try {
		checkedRoot = await safeRoot(root);
	} catch (error) {
		return { kind: "invalid", reason: `retained-session root is unsafe: ${boundedReason(error)}` };
	}
	if (!checkedRoot) return { kind: "unavailable", reason: "retained-session root is unavailable" };
	if (resolve(file.path) !== resolve(join(root, file.filename))) {
		return { kind: "invalid", reason: "source path is not the expected direct child" };
	}
	try {
		const stat = await lstat(file.path);
		if (!stat.isFile() || stat.isSymbolicLink())
			return { kind: "invalid", reason: "source is no longer a regular file" };
		const canonical = await realpath(file.path);
		if (!containedDirectChild(file.path, root, checkedRoot, canonical)) {
			return { kind: "invalid", reason: "source no longer resolves inside the retained-session root" };
		}
		if (!sameSubagentFileSignature(signature(stat), file.signature)) {
			return { kind: "changed", reason: "source stat signature changed" };
		}
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "unavailable", reason: "source is unavailable" };
		return { kind: "invalid", reason: `source cannot be validated: ${boundedReason(error)}` };
	}
	const lease = await classifyLease({
		root,
		rootCanonical: checkedRoot,
		sessionId: file.sessionId,
		nowMs: (options.now ?? Date.now)(),
		isPidAlive: options.isPidAlive,
		signal: options.signal,
	});
	return lease.kind === "active" ? { kind: "active", reason: lease.reason } : { kind: "eligible" };
}

export async function readStableSubagentHistoryRanges(
	file: SubagentHistoryFile,
	ranges: { offset: number; length: number }[],
	options: FileOptions = {},
): Promise<StableSubagentRangeRead> {
	const maxBytes = options.maxSessionBytes ?? SUBAGENT_HISTORY_SESSION_BYTES;
	if (file.signature.size > maxBytes) {
		return { kind: "invalid", reason: `source exceeds the ${maxBytes}-byte per-session limit` };
	}
	let priorEnd = 0;
	for (const range of ranges) {
		if (
			!Number.isSafeInteger(range.offset) ||
			!Number.isSafeInteger(range.length) ||
			range.offset < priorEnd ||
			range.length < 0 ||
			range.offset + range.length > file.signature.size
		) {
			return { kind: "invalid", reason: "cached raw byte range falls outside the retained source" };
		}
		priorEnd = range.offset + range.length;
	}
	const before = await revalidateSubagentHistoryFile(file, options);
	if (before.kind !== "eligible") return before;
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "unavailable", reason: "source vanished before raw read" };
		return { kind: "changed", reason: `source could not be opened for raw read: ${boundedReason(error)}` };
	}
	try {
		const beforeStat = await handle.stat();
		if (!beforeStat.isFile() || !sameSubagentFileSignature(signature(beforeStat), file.signature)) {
			return { kind: "changed", reason: "source changed before raw ranges were read" };
		}
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const result: string[] = [];
		for (const range of ranges) {
			options.signal?.throwIfAborted();
			const bytes = Buffer.alloc(range.length);
			let readOffset = 0;
			while (readOffset < range.length) {
				options.signal?.throwIfAborted();
				const length = Math.min(READ_BLOCK_BYTES, range.length - readOffset);
				const read = await handle.read(bytes, readOffset, length, range.offset + readOffset);
				if (read.bytesRead === 0) break;
				readOffset += read.bytesRead;
			}
			if (readOffset !== range.length) return { kind: "changed", reason: "source changed during raw range read" };
			try {
				result.push(decoder.decode(bytes));
			} catch (error) {
				return { kind: "invalid", reason: `raw entry is no longer valid UTF-8: ${boundedReason(error)}` };
			}
		}
		const afterStat = await handle.stat();
		if (!sameSubagentFileSignature(signature(afterStat), file.signature)) {
			return { kind: "changed", reason: "source changed while raw ranges were read" };
		}
		const after = await revalidateSubagentHistoryFile(file, options);
		if (after.kind !== "eligible") return after;
		return { kind: "read", ranges: result };
	} finally {
		await handle.close();
	}
}

function expectedFilename(timestamp: string, sessionId: string): string {
	return `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
}

function latestName(parsed: ParsedSession): string | null {
	for (let index = parsed.entries.length - 1; index >= 0; index--) {
		const entry = parsed.entries[index];
		if (entry.sessionNamePresent) return entry.sessionName ?? null;
	}
	return null;
}

export async function readStableSubagentHistoryFile(
	file: SubagentHistoryFile,
	options: FileOptions = {},
): Promise<StableSubagentRead> {
	const maxBytes = options.maxSessionBytes ?? SUBAGENT_HISTORY_SESSION_BYTES;
	if (file.signature.size > maxBytes) {
		return { kind: "invalid", reason: `source exceeds the ${maxBytes}-byte per-session limit` };
	}
	const before = await revalidateSubagentHistoryFile(file, options);
	if (before.kind !== "eligible") return before;
	let read: Awaited<ReturnType<typeof readBoundedHandle>>;
	try {
		read = await readBoundedHandle(file.path, file.signature.size, options.signal);
	} catch (error) {
		if (options.signal?.aborted) options.signal.throwIfAborted();
		if (errorCode(error) === "ENOENT") return { kind: "unavailable", reason: "source vanished during read" };
		return { kind: "changed", reason: `source could not be read stably: ${boundedReason(error)}` };
	}
	if (!sameSubagentFileSignature(read.before, file.signature) || !sameSubagentFileSignature(read.before, read.after)) {
		return { kind: "changed", reason: "source changed while it was read" };
	}
	let parsed: ParsedSession;
	try {
		parsed = parseSessionJsonlBytes(read.bytes);
	} catch (error) {
		return { kind: "invalid", reason: `source is not valid Pi v3 JSONL: ${boundedReason(error)}` };
	}
	if (parsed.header.id.toLowerCase() !== file.sessionId) {
		return { kind: "invalid", reason: "filename UUID does not match the session header" };
	}
	if (!Number.isFinite(Date.parse(parsed.header.timestamp))) {
		return { kind: "invalid", reason: "session header timestamp is invalid" };
	}
	if (!isAbsolute(parsed.header.cwd)) return { kind: "invalid", reason: "session header cwd is not absolute" };
	if (expectedFilename(parsed.header.timestamp, file.sessionId).toLowerCase() !== file.filename.toLowerCase()) {
		return { kind: "invalid", reason: "filename timestamp does not match the session header" };
	}
	const after = await revalidateSubagentHistoryFile(file, options);
	if (after.kind !== "eligible") return after;
	return { kind: "read", file, bytes: read.bytes, parsed, name: latestName(parsed) };
}
