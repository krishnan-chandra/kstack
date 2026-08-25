/** Native Pi session persistence and retention for Kstack child agents. */
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type BoundaryValue, isNumber, isObject, isString } from "./validation.ts";

const SAFE_LABEL = /^[A-Za-z0-9_-]{1,16}$/;
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_CAP = 500;
const MALFORMED_LEASE_STALE_MS = 60 * 60 * 1000;
const HEADER_READ_BYTES = 16 * 1024;
const DIAGNOSTIC_BYTES = 1024;

export interface ChildSessionIdentity {
	owner: string;
	label: string;
}

export type MissingSessionReason =
	| "setup-failed"
	| "spawn-failed"
	| "header-missing"
	| "file-missing"
	| "protocol-mismatch"
	| "not-reported";

export type ChildSession =
	| { kind: "persisted"; id: string; name: string; file: string }
	| { kind: "missing"; id?: string; name?: string; reason: MissingSessionReason };

export interface ObservedSessionHeader {
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
}

interface PreparedSubagentSession {
	id: string;
	name: string;
	root: string;
	expectedCwd: string;
	cliArgs: string[];
	leaseFile: string;
}

interface SessionStoreFailure {
	session: Extract<ChildSession, { kind: "missing" }>;
	error: string;
}

type PrepareSessionResult =
	| { ok: true; prepared: PreparedSubagentSession }
	| { ok: false; failure: SessionStoreFailure };
type MarkSpawnedResult = { ok: true } | { ok: false; failure: SessionStoreFailure };

interface FinishSubagentSession {
	header?: ObservedSessionHeader;
	spawnFailed: boolean;
	forcedMissingReason?: "setup-failed" | "protocol-mismatch";
}

export interface SubagentSessionStore {
	prepare(identity: ChildSessionIdentity, cwd: string): PrepareSessionResult;
	markSpawned(prepared: PreparedSubagentSession, childPid: number | undefined): MarkSpawnedResult;
	finish(prepared: PreparedSubagentSession, outcome: FinishSubagentSession): ChildSession;
}

interface StoreOptions {
	root?: string;
	pid?: number;
	now?: () => Date;
	uuid?: () => string;
	isPidAlive?: (pid: number) => boolean;
	onDiagnostic?: (message: string) => void;
	cap?: number;
}

function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: BoundaryValue): BoundaryValue {
	if (!isObject(error) || error === null || !("code" in error)) return undefined;
	return error.code;
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

function regularFile(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

function directChild(path: string, root: string): boolean {
	return dirname(resolve(path)) === resolve(root);
}

function sessionFileName(header: ObservedSessionHeader): string {
	return `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
}

function parseLease(raw: string): { state: "pending" | "spawned"; pid: number; createdAt: string } | undefined {
	try {
		const value: BoundaryValue = JSON.parse(raw);
		if (!isObject(value) || value === null || Array.isArray(value)) return undefined;
		if (!("state" in value) || (value.state !== "pending" && value.state !== "spawned")) return undefined;
		if (!("pid" in value) || !isNumber(value.pid) || !Number.isSafeInteger(value.pid) || value.pid <= 0)
			return undefined;
		if (!("createdAt" in value) || !isString(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)))
			return undefined;
		return { state: value.state, pid: value.pid, createdAt: value.createdAt };
	} catch {
		return undefined;
	}
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function filenameTimestamp(name: string): number | undefined {
	const match = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!match) return undefined;
	const timestamp = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseHeaderTimestamp(path: string, mtimeMs: number): number {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const bytes = Buffer.alloc(HEADER_READ_BYTES);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		const first = bytes.subarray(0, count).toString("utf8").split("\n", 1)[0];
		const value: BoundaryValue = JSON.parse(first);
		if (isObject(value) && value !== null && "timestamp" in value && isString(value.timestamp)) {
			const timestamp = Date.parse(value.timestamp);
			if (Number.isFinite(timestamp)) return timestamp;
		}
	} catch {
		// File mtime is the documented fallback for malformed or unreadable headers.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return mtimeMs;
}

export function validateSessionHeader(
	value: BoundaryValue,
	prepared: PreparedSubagentSession,
): { ok: true; header: ObservedSessionHeader } | { ok: false; error: string } {
	if (!isObject(value) || value === null || Array.isArray(value)) return { ok: false, error: "invalid session header" };
	if (!("type" in value) || value.type !== "session")
		return { ok: false, error: "first child record was not a session header" };
	if (!("version" in value) || value.version !== 3) return { ok: false, error: "unsupported session header version" };
	if (!("id" in value) || value.id !== prepared.id) return { ok: false, error: "session header ID mismatch" };
	if (!("timestamp" in value) || !isString(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)))
		return { ok: false, error: "invalid session header timestamp" };
	if (!("cwd" in value) || !isString(value.cwd) || canonicalPath(value.cwd) !== prepared.expectedCwd)
		return { ok: false, error: "session header cwd mismatch" };
	return { ok: true, header: { version: 3, id: value.id, timestamp: value.timestamp, cwd: value.cwd } };
}

export function createSubagentSessionStore(options: StoreOptions = {}): SubagentSessionStore {
	const root = resolve(options.root ?? join(homedir(), ".pi", "kstack", "subagents"));
	const pid = options.pid ?? process.pid;
	const now = options.now ?? (() => new Date());
	const uuid = options.uuid ?? randomUUID;
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	const cap = options.cap ?? SESSION_CAP;
	const finished = new Map<string, ChildSession>();
	const diagnostic = (message: string) => options.onDiagnostic?.(message.slice(0, DIAGNOSTIC_BYTES));

	function ensureDirectory(path: string): void {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe managed session directory: ${path}`);
		try {
			chmodSync(path, 0o700);
		} catch {}
	}

	function missing(
		reason: MissingSessionReason,
		prepared?: PreparedSubagentSession,
	): Extract<ChildSession, { kind: "missing" }> {
		return {
			kind: "missing",
			...(prepared ? { id: prepared.id, name: prepared.name } : undefined),
			reason,
		};
	}

	function activeIds(activeRoot: string): Set<string> {
		const active = new Set<string>();
		for (const entry of readdirSync(activeRoot)) {
			if (!entry.endsWith(".json") || entry.includes(".tmp")) continue;
			const id = entry.slice(0, -5);
			if (!SAFE_ID.test(id)) continue;
			const path = join(activeRoot, entry);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			let lease: ReturnType<typeof parseLease>;
			try {
				lease = parseLease(readFileSync(path, "utf8"));
			} catch {
				lease = undefined;
			}
			if (lease && isPidAlive(lease.pid)) active.add(id);
			else if (!lease && now().getTime() - stat.mtimeMs < MALFORMED_LEASE_STALE_MS) active.add(id);
			else {
				try {
					unlinkSync(path);
				} catch {}
			}
		}
		return active;
	}

	function isActive(activeRoot: string, id: string): boolean {
		const path = join(activeRoot, `${id}.json`);
		if (!regularFile(path)) return false;
		try {
			const lease = parseLease(readFileSync(path, "utf8"));
			return lease !== undefined && isPidAlive(lease.pid);
		} catch {
			return false;
		}
	}

	function prune(): void {
		const activeRoot = join(root, ".active");
		const active = activeIds(activeRoot);
		const files: { path: string; id: string; order: number; name: string }[] = [];
		for (const name of readdirSync(root)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(root, name);
			if (!directChild(path, root) || !regularFile(path)) continue;
			const match = name.match(/_([0-9a-f-]{36})\.jsonl$/i);
			if (!match || !SAFE_ID.test(match[1])) continue;
			const encodedTimestamp = filenameTimestamp(name);
			const order = encodedTimestamp ?? parseHeaderTimestamp(path, statSync(path).mtimeMs);
			files.push({ path, id: match[1], order, name });
		}
		files.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
		let excess = files.length - cap;
		for (const file of files) {
			if (excess <= 0) break;
			if (active.has(file.id)) continue;
			if (!directChild(file.path, root) || !regularFile(file.path)) continue;
			// Recheck only the candidate lease to close the race with a newly started child.
			if (isActive(activeRoot, file.id)) continue;
			try {
				unlinkSync(file.path);
				excess--;
			} catch (error) {
				if (errorCode(error) === "ENOENT") excess--;
				else diagnostic(`Could not prune ${basename(file.path)}: ${errorMessage(error)}`);
			}
		}
	}

	return {
		prepare(identity, cwd) {
			if (!SAFE_LABEL.test(identity.owner) || !SAFE_LABEL.test(identity.label)) {
				return {
					ok: false,
					failure: { session: { kind: "missing", reason: "setup-failed" }, error: "Invalid child session identity." },
				};
			}
			const name = `${identity.owner}/${identity.label}`;
			let prepared: PreparedSubagentSession | undefined;
			try {
				ensureDirectory(root);
				const activeRoot = join(root, ".active");
				ensureDirectory(activeRoot);
				for (let attempt = 0; attempt < 10; attempt++) {
					const id = uuid();
					if (!SAFE_ID.test(id)) continue;
					if (readdirSync(root).some((entry) => entry.endsWith(`_${id}.jsonl`))) continue;
					const leaseFile = join(activeRoot, `${id}.json`);
					prepared = {
						id,
						name,
						root,
						expectedCwd: canonicalPath(cwd),
						cliArgs: ["--session-id", id, "--session-dir", root, "--name", name],
						leaseFile,
					};
					try {
						writeFileSync(leaseFile, JSON.stringify({ state: "pending", pid, createdAt: now().toISOString() }), {
							flag: "wx",
							mode: 0o600,
						});
					} catch (error) {
						if (errorCode(error) === "EEXIST") continue;
						throw error;
					}
					return { ok: true, prepared };
				}
				throw new Error("Could not allocate a unique child session ID.");
			} catch (error) {
				return {
					ok: false,
					failure: {
						session: missing("setup-failed", prepared),
						error: `Session setup failed: ${errorMessage(error)}`,
					},
				};
			}
		},
		markSpawned(prepared, childPid) {
			if (childPid === undefined || !Number.isSafeInteger(childPid) || childPid <= 0) return { ok: true };
			const temporary = `${prepared.leaseFile}.${pid}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, JSON.stringify({ state: "spawned", pid: childPid, createdAt: now().toISOString() }), {
					flag: "wx",
					mode: 0o600,
				});
				renameSync(temporary, prepared.leaseFile);
				return { ok: true };
			} catch (error) {
				try {
					unlinkSync(temporary);
				} catch {}
				return {
					ok: false,
					failure: {
						session: missing("setup-failed", prepared),
						error: `Session lease failed: ${errorMessage(error)}`,
					},
				};
			}
		},
		finish(prepared, outcome) {
			const prior = finished.get(prepared.id);
			if (prior) return prior;
			try {
				unlinkSync(prepared.leaseFile);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") diagnostic(`Could not release session lease: ${errorMessage(error)}`);
			}
			let result: ChildSession;
			if (outcome.forcedMissingReason) result = missing(outcome.forcedMissingReason, prepared);
			else if (outcome.spawnFailed) result = missing("spawn-failed", prepared);
			else {
				let path: string | undefined;
				if (outcome.header) path = join(root, sessionFileName(outcome.header));
				else {
					try {
						const matches = readdirSync(root).filter((entry) => entry.endsWith(`_${prepared.id}.jsonl`));
						if (matches.length === 1) path = join(root, matches[0]);
					} catch (error) {
						diagnostic(`Could not inspect child session files: ${errorMessage(error)}`);
					}
				}
				if (path && directChild(path, root) && regularFile(path))
					result = { kind: "persisted", id: prepared.id, name: prepared.name, file: path };
				else result = missing(outcome.header ? "file-missing" : "header-missing", prepared);
			}
			finished.set(prepared.id, result);
			try {
				prune();
			} catch (error) {
				diagnostic(`Could not prune child sessions: ${errorMessage(error)}`);
			}
			return result;
		},
	};
}
