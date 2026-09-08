import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExecFn } from "../shared/git-exec.ts";
import { getAgentDir } from "../shared/kstack-config.ts";
import { isRecord } from "../shared/narrow.ts";
import { resolveRepositoryIdentity } from "../shared/repository-identity.ts";
import { type BoundaryValue, isString } from "../shared/validation.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";

export type ServiceTier = "flex" | "default" | "priority" | "unknown";
export type StatsRange = "process" | "today" | "7d" | "30d";
export type UnknownReason =
	| "pending"
	| "no-response-id"
	| "lookup-failed"
	| "null-or-unrecognized-tier"
	| "invalid-response";
export type GenerationKeyHash = string & { readonly __brand: "GenerationKeyHash" };

export type LedgerEvent =
	| {
			version: 1;
			kind: "rewrite";
			eventId: string;
			processId: string;
			scopeKey: string;
			at: string;
	  }
	| {
			version: 1;
			kind: "generation";
			eventId: string;
			processId: string;
			scopeKey: string;
			at: string;
			generationKeyHash?: GenerationKeyHash;
			state: "observed" | "resolved";
			tier: ServiceTier;
			reason?: UnknownReason;
	  };

export type LedgerInput =
	| {
			kind: "rewrite";
			eventId: string;
			at: string;
	  }
	| {
			kind: "generation";
			eventId: string;
			at: string;
			generationKeyHash?: GenerationKeyHash;
			state: "observed" | "resolved";
			tier: ServiceTier;
			reason?: UnknownReason;
	  };

interface LedgerFileSystem {
	mkdir(path: string): Promise<void>;
	appendFile(path: string, content: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	readFile(path: string): Promise<string>;
	stat(path: string): Promise<{ size: number; mtimeMs: number }>;
	unlink(path: string): Promise<void>;
}

export type FloorScopeLabel = "repository" | "working directory";

interface FloorScopeResolution {
	key: string;
	label: FloorScopeLabel;
}

interface FloorLedgerReadResult {
	events: LedgerEvent[];
	scopeLabel: FloorScopeLabel;
}

interface FloorLedgerOptions {
	/** Parent of all scope directories; defaults to <agentDir>/openrouter-floor/ledger-v1. */
	rootDirectory?: string;
	resolveScope?: (cwd: string) => Promise<FloorScopeResolution>;
	fileSystem?: LedgerFileSystem;
	processId?: string;
	now?: () => Date;
	maxLinesPerShard?: number;
	maxTotalBytes?: number;
	onDiagnostic?: (diagnostic: string) => void;
}

export interface FloorLedger {
	readonly processId: string;
	append(scope: string, input: LedgerInput): Promise<void>;
	read(scope: string): Promise<FloorLedgerReadResult>;
	flush(): Promise<void>;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LINES_PER_SHARD = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_EVENT_LINES = 20_000;
const IDENTITY_OUTPUT_CAP_BYTES = 64 * 1024;
const SHARD_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROCESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,240}$/;

const nativeFileSystem: LedgerFileSystem = {
	async mkdir(path) {
		await mkdir(path, { recursive: true, mode: 0o700 });
	},
	async appendFile(path, content) {
		await appendFile(path, content, { encoding: "utf8", mode: 0o600 });
	},
	async readdir(path) {
		return await readdir(path, { encoding: "utf8" });
	},
	async readFile(path) {
		return await readFile(path, "utf8");
	},
	async stat(path) {
		const result = await stat(path);
		return { size: result.size, mtimeMs: result.mtimeMs };
	},
	async unlink(path) {
		await unlink(path);
	},
};

const nodeExec: ExecFn = async (command, args, options) =>
	new Promise((resolveResult) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd,
				timeout: options.timeout,
				killSignal: "SIGKILL",
				maxBuffer: IDENTITY_OUTPUT_CAP_BYTES,
				signal: options.signal,
			},
			(error, stdout, stderr) => {
				let code = 0;
				if (error !== null) code = 1;
				resolveResult({
					code,
					stdout: String(stdout),
					stderr: String(stderr),
					killed: error?.killed,
				});
			},
		);
	});

function isNotFound(error: BoundaryValue): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isServiceTier(value: BoundaryValue): value is ServiceTier {
	return value === "flex" || value === "default" || value === "priority" || value === "unknown";
}

function isUnknownReason(value: BoundaryValue): value is UnknownReason {
	return (
		value === "pending" ||
		value === "no-response-id" ||
		value === "lookup-failed" ||
		value === "null-or-unrecognized-tier" ||
		value === "invalid-response"
	);
}

function isValidEventId(value: BoundaryValue): value is string {
	return isString(value) && EVENT_ID_PATTERN.test(value);
}

function isValidProcessId(value: BoundaryValue): value is string {
	return isString(value) && PROCESS_ID_PATTERN.test(value);
}

function isValidScopeKey(value: BoundaryValue): value is string {
	return isString(value) && HASH_PATTERN.test(value);
}

function isValidGenerationKeyHash(value: BoundaryValue): value is GenerationKeyHash {
	return isString(value) && HASH_PATTERN.test(value);
}

function isValidTimestamp(value: BoundaryValue): value is string {
	return isString(value) && Number.isFinite(Date.parse(value));
}

function parseLedgerEvent(value: BoundaryValue, expectedScopeKey: string): LedgerEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== 1 || !isValidEventId(value.eventId) || !isValidProcessId(value.processId)) return undefined;
	if (!isValidScopeKey(value.scopeKey) || value.scopeKey !== expectedScopeKey || !isValidTimestamp(value.at))
		return undefined;

	if (value.kind === "rewrite") {
		return {
			version: 1,
			kind: "rewrite",
			eventId: value.eventId,
			processId: value.processId,
			scopeKey: value.scopeKey,
			at: value.at,
		};
	}

	if (value.kind !== "generation" || (value.state !== "observed" && value.state !== "resolved")) return undefined;
	if (!isServiceTier(value.tier)) return undefined;
	if (value.reason !== undefined && !isUnknownReason(value.reason)) return undefined;
	if (value.tier !== "unknown" && value.reason !== undefined) return undefined;
	if (value.state === "observed" && value.tier !== "unknown") return undefined;
	if (value.generationKeyHash !== undefined && !isValidGenerationKeyHash(value.generationKeyHash)) return undefined;
	if (value.state === "resolved" && value.generationKeyHash === undefined) return undefined;

	const event: LedgerEvent = {
		version: 1,
		kind: "generation",
		eventId: value.eventId,
		processId: value.processId,
		scopeKey: value.scopeKey,
		at: value.at,
		state: value.state,
		tier: value.tier,
	};
	if (value.generationKeyHash !== undefined) event.generationKeyHash = value.generationKeyHash;
	if (value.reason !== undefined) event.reason = value.reason;
	return event;
}

function materializeEvent(input: LedgerInput, processId: string, scopeKey: string): LedgerEvent {
	if (input.kind === "rewrite") {
		return {
			version: 1,
			kind: "rewrite",
			eventId: input.eventId,
			processId,
			scopeKey,
			at: input.at,
		};
	}

	const event: LedgerEvent = {
		version: 1,
		kind: "generation",
		eventId: input.eventId,
		processId,
		scopeKey,
		at: input.at,
		state: input.state,
		tier: input.tier,
	};
	if (input.generationKeyHash !== undefined) event.generationKeyHash = input.generationKeyHash;
	if (input.reason !== undefined) event.reason = input.reason;
	return event;
}

function diagnostic(onDiagnostic: (diagnostic: string) => void, message: string): void {
	try {
		onDiagnostic(message);
	} catch {
		// Diagnostics must never affect provider traffic or ledger reads.
	}
}

function workingDirectoryScope(cwd: string): FloorScopeResolution {
	let canonical: string;
	try {
		canonical = realpathSync(cwd);
	} catch {
		canonical = resolve(cwd);
	}
	return {
		key: createHash("sha256").update(canonical).digest("hex"),
		label: "working directory",
	};
}

async function defaultResolveScope(cwd: string): Promise<FloorScopeResolution> {
	const identity = await resolveRepositoryIdentity(nodeExec, cwd, {
		backend: loadVcsBackend().backend,
		timeoutMs: 5_000,
	});
	return identity.ok ? { key: identity.key, label: "repository" } : workingDirectoryScope(cwd);
}

export function defaultLedgerRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "openrouter-floor", "ledger-v1");
}

export function ledgerDirectoryFor(rootDirectory: string, scopeKey: string): string {
	return join(rootDirectory, scopeKey);
}

export function hashGenerationId(responseId: string): GenerationKeyHash {
	const hash = createHash("sha256").update(responseId).digest("hex");
	if (!isValidGenerationKeyHash(hash)) throw new Error("Could not create a generation key hash");
	return hash;
}

function processIdForRuntime(): string {
	return `p${process.pid}-${randomUUID()}`;
}

function shardDateFor(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function fileNameFor(processId: string, date: Date): string {
	return `${processId}.${shardDateFor(date)}.jsonl`;
}

function shardDateFromName(name: string): string | undefined {
	if (!name.endsWith(".jsonl")) return undefined;
	const stem = name.slice(0, -".jsonl".length);
	const separator = stem.lastIndexOf(".");
	if (separator === -1) return isValidProcessId(stem) ? "" : undefined;
	const processId = stem.slice(0, separator);
	const date = stem.slice(separator + 1);
	return isValidProcessId(processId) && SHARD_DATE_PATTERN.test(date) ? date : undefined;
}

function validShardName(name: string): boolean {
	return shardDateFromName(name) !== undefined;
}

function dateIsRetained(value: string, now: Date): boolean {
	const at = Date.parse(value);
	return at >= now.getTime() - RETENTION_MS;
}

export function createFloorLedger(options: FloorLedgerOptions = {}): FloorLedger {
	const fileSystem = options.fileSystem ?? nativeFileSystem;
	const processId = options.processId ?? processIdForRuntime();
	if (!isValidProcessId(processId)) throw new Error("Invalid floor ledger process ID");
	const now = options.now ?? (() => new Date());
	const maxLinesPerShard = options.maxLinesPerShard ?? DEFAULT_MAX_LINES_PER_SHARD;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
	if (!Number.isInteger(maxLinesPerShard) || maxLinesPerShard < 1) throw new Error("Invalid floor ledger line limit");
	if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error("Invalid floor ledger byte limit");
	const onDiagnostic = options.onDiagnostic ?? (() => {});
	const rootDirectory = options.rootDirectory ?? defaultLedgerRoot();
	const resolveScope = options.resolveScope ?? defaultResolveScope;
	let queue = Promise.resolve();
	const lineCounts = new Map<string, number>();
	const scopeResolutions = new Map<string, Promise<FloorScopeResolution>>();

	function resolutionFor(cwd: string): Promise<FloorScopeResolution> {
		const existing = scopeResolutions.get(cwd);
		if (existing !== undefined) return existing;
		const pending = Promise.resolve()
			.then(() => resolveScope(cwd))
			.catch(() => workingDirectoryScope(cwd));
		scopeResolutions.set(cwd, pending);
		return pending;
	}

	function enqueue(operation: () => Promise<void>): Promise<void> {
		const result = queue.then(operation);
		queue = result.catch(() => {});
		return result;
	}

	async function pruneOldShards(directory: string, names: string[]): Promise<string[]> {
		const cutoff = now().getTime() - RETENTION_MS;
		const retained: string[] = [];
		for (const name of names) {
			const shardDate = shardDateFromName(name);
			if (shardDate === undefined) continue;
			try {
				const metadata = await fileSystem.stat(join(directory, name));
				const bucketExpired = shardDate !== "" && Date.parse(`${shardDate}T23:59:59.999Z`) < cutoff;
				if (bucketExpired || (shardDate === "" && metadata.mtimeMs < cutoff)) {
					await fileSystem.unlink(join(directory, name));
					diagnostic(onDiagnostic, "ledger shard pruned: retention");
					continue;
				}
			} catch (error) {
				if (!isNotFound(error)) diagnostic(onDiagnostic, "ledger shard prune failed");
			}
			retained.push(name);
		}
		return retained;
	}

	async function scopeBytes(directory: string): Promise<number> {
		let names: string[];
		try {
			names = await fileSystem.readdir(directory);
		} catch (error) {
			if (isNotFound(error)) return 0;
			throw error;
		}
		let total = 0;
		for (const name of names.filter(validShardName)) {
			try {
				total += (await fileSystem.stat(join(directory, name))).size;
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		}
		return total;
	}

	async function appendNow(scope: string, input: LedgerInput): Promise<void> {
		const at = Date.parse(input.at);
		if (!Number.isFinite(at) || !dateIsRetained(input.at, now())) {
			diagnostic(onDiagnostic, "ledger append rejected: timestamp outside retention");
			return;
		}
		if (!isValidEventId(input.eventId)) {
			diagnostic(onDiagnostic, "ledger append rejected: invalid event id");
			return;
		}
		const resolution = await resolutionFor(scope);
		const scopeKey = resolution.key;
		const directory = ledgerDirectoryFor(rootDirectory, scopeKey);
		const path = join(directory, fileNameFor(processId, now()));

		const event = materializeEvent(input, processId, scopeKey);
		if (!parseLedgerEvent(event, scopeKey)) {
			diagnostic(onDiagnostic, "ledger append rejected: invalid event");
			return;
		}
		const line = `${JSON.stringify(event)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > MAX_EVENT_BYTES) {
			diagnostic(onDiagnostic, "ledger append dropped: event byte limit");
			return;
		}
		await fileSystem.mkdir(directory);
		const names = await fileSystem.readdir(directory);
		await pruneOldShards(directory, names);
		let count = lineCounts.get(path);
		if (count === undefined) {
			try {
				const content = await fileSystem.readFile(path);
				count = content.split(/\r?\n/).filter((storedLine) => storedLine.length > 0).length;
			} catch (error) {
				if (!isNotFound(error)) throw error;
				count = 0;
			}
		}
		if (count >= maxLinesPerShard) {
			diagnostic(onDiagnostic, "ledger append dropped: shard line limit");
			return;
		}
		const totalBytes = await scopeBytes(directory);
		if (totalBytes + bytes > maxTotalBytes) {
			diagnostic(onDiagnostic, "ledger append dropped: scope byte limit");
			return;
		}
		await fileSystem.appendFile(path, line);
		lineCounts.set(path, count + 1);
	}

	async function read(scope: string): Promise<FloorLedgerReadResult> {
		const resolution = await resolutionFor(scope);
		const scopeKey = resolution.key;
		const directory = ledgerDirectoryFor(rootDirectory, scopeKey);
		let names: string[];
		try {
			names = await fileSystem.readdir(directory);
		} catch (error) {
			if (isNotFound(error)) return { events: [], scopeLabel: resolution.label };
			diagnostic(onDiagnostic, "ledger read failed: directory unavailable");
			return { events: [], scopeLabel: resolution.label };
		}

		names = await pruneOldShards(directory, names);
		const events: LedgerEvent[] = [];
		let totalBytes = 0;
		for (const name of names.filter(validShardName).sort()) {
			const path = join(directory, name);
			let size: number;
			try {
				size = (await fileSystem.stat(path)).size;
			} catch (error) {
				if (!isNotFound(error)) diagnostic(onDiagnostic, "ledger read skipped: shard stat failed");
				continue;
			}
			if (size > MAX_EVENT_BYTES * MAX_EVENT_LINES || totalBytes + size > maxTotalBytes) {
				diagnostic(onDiagnostic, "ledger read skipped: shard budget exceeded");
				continue;
			}
			totalBytes += size;
			let content: string;
			try {
				content = await fileSystem.readFile(path);
			} catch (error) {
				if (!isNotFound(error)) diagnostic(onDiagnostic, "ledger read skipped: shard unavailable");
				continue;
			}
			const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
			if (lines.length > MAX_EVENT_LINES) {
				diagnostic(onDiagnostic, "ledger read skipped: line budget exceeded");
				continue;
			}
			for (const line of lines) {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					diagnostic(onDiagnostic, "ledger read skipped: malformed JSON line");
					continue;
				}
				const event = parseLedgerEvent(value, scopeKey);
				if (!event) {
					diagnostic(onDiagnostic, "ledger read skipped: invalid event");
					continue;
				}
				if (dateIsRetained(event.at, now())) events.push(event);
			}
		}
		return { events, scopeLabel: resolution.label };
	}

	return {
		processId,
		append(scope, input) {
			return enqueue(() => appendNow(scope, input));
		},
		read,
		async flush() {
			await queue;
		},
	};
}
