/** Bounded binary access to pinned Git tree metadata and blob objects. */

import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Writable } from "node:stream";
import type { ExecFn } from "../shared/git-exec.ts";

const OBJECT_ID_RE = /^[0-9a-f]{40}$/;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_TREE_METADATA_BYTES = 64 * 1024 * 1024;
const STDERR_BYTES = 8 * 1024;
const BATCH_HEADER_BYTES = 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const EMPTY_BUFFER = Buffer.alloc(0);

interface BinaryReadable extends AsyncIterable<Buffer> {
	on(event: "data", listener: (chunk: Buffer) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
}

interface SpawnedGitProcess {
	stdin: Writable;
	stdout: BinaryReadable;
	stderr: BinaryReadable;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface GitSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: false;
	stdio: ["pipe", "pipe", "pipe"];
}

/** Process injection boundary for binary Git tests. */
export type SnapshotGitSpawn = (command: string, args: string[], options: GitSpawnOptions) => SpawnedGitProcess;

/** Binary-process controls shared by tree enumeration and batch object reads. */
export interface SnapshotProcessOptions {
	spawn?: SnapshotGitSpawn;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	killGraceMs?: number;
}

/** One recursive `git ls-tree` record. Paths have passed fatal UTF-8 decoding only. */
export interface SnapshotTreeEntry {
	mode: string;
	objectType: string;
	objectId: string;
	size: number | null;
	path: string;
}

interface SnapshotTree {
	entries: SnapshotTreeEntry[];
	blobBytes: number;
}

export interface SnapshotBlob {
	objectId: string;
	size: number;
	path: string;
}

/** One-at-a-time binary blob reader backed by one `git cat-file --batch` child. */
export interface SnapshotObjectReader {
	readBlob(blob: SnapshotBlob, writeChunk: (chunk: Buffer) => Promise<void>): Promise<void>;
	finish(): Promise<void>;
	abort(): Promise<void>;
}

interface CloseResult {
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface BatchHeader {
	objectId: string;
	objectType: string;
	size: number;
}

function defaultSpawn(command: string, args: string[], options: GitSpawnOptions): SpawnedGitProcess {
	return nodeSpawn(command, args, options);
}

function gitEnvironment(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...(source ?? process.env) };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_COMMON_DIR",
		"GIT_PREFIX",
	]) {
		delete env[key];
	}
	return env;
}

function gitArgs(gitDir: string, args: string[]): string[] {
	return ["--no-replace-objects", `--git-dir=${gitDir}`, ...args];
}

class ManagedGitProcess {
	readonly child: SpawnedGitProcess;
	readonly closePromise: Promise<CloseResult>;
	private closed = false;
	private failure: Error | undefined;
	private failureReject: ((error: Error) => void) | undefined;
	private readonly failurePromise: Promise<never>;
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private killTimer: ReturnType<typeof setTimeout> | undefined;
	private stopping = false;
	private stderr = EMPTY_BUFFER;
	private stderrTruncated = false;
	private readonly killGraceMs: number;

	constructor(commandArgs: string[], cwd: string, processOptions: SnapshotProcessOptions) {
		const spawnImpl = processOptions.spawn ?? defaultSpawn;
		this.killGraceMs = processOptions.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

		try {
			this.child = spawnImpl("git", commandArgs, {
				cwd,
				env: gitEnvironment(processOptions.env),
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not start Git: ${message}`);
		}

		this.failurePromise = new Promise<never>((_resolve, reject) => {
			this.failureReject = reject;
		});
		void this.failurePromise.catch(() => {});
		this.closePromise = new Promise((resolve) => {
			this.child.on("close", (code, signal) => {
				this.closed = true;
				this.clearLifecycle();
				if (code !== 0) {
					const detail = this.diagnostic() || `exit ${code}, signal ${signal}`;
					this.fail(new Error(`Git process failed: ${detail}`));
				}
				resolve({ code, signal });
			});
		});
		this.child.on("error", (error) => {
			this.fail(new Error(`Git process failed: ${error.message}`));
		});
		this.child.stdin.on("error", (error) => {
			this.failInput(error);
		});
		this.child.stderr.on("data", (chunk) => {
			const remaining = STDERR_BYTES - this.stderr.byteLength;
			if (remaining > 0) this.stderr = Buffer.concat([this.stderr, chunk.subarray(0, remaining)]);
			if (chunk.byteLength > remaining) this.stderrTruncated = true;
		});
		this.child.stderr.on("error", (error) => {
			this.fail(new Error(`Git stderr failed: ${error.message}`));
		});

		const timeoutMs = processOptions.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
		this.timeout = setTimeout(() => {
			this.fail(new Error(`Git operation timed out after ${timeoutMs} ms.`));
		}, timeoutMs);
	}

	bindSignal(signal: AbortSignal | undefined): void {
		if (signal === undefined) return;
		const abort = () => this.fail(new Error("Git operation was aborted."));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		this.signalCleanup = () => signal.removeEventListener("abort", abort);
	}

	private signalCleanup: (() => void) | undefined;

	private clearLifecycle(): void {
		if (this.timeout) clearTimeout(this.timeout);
		if (this.killTimer) clearTimeout(this.killTimer);
		this.signalCleanup?.();
		this.timeout = undefined;
		this.killTimer = undefined;
		this.signalCleanup = undefined;
	}

	private kill(signal: "SIGTERM" | "SIGKILL"): void {
		try {
			this.child.kill(signal);
		} catch {
			/* The close event remains the process-reaping boundary. */
		}
	}

	private stop(): void {
		if (this.stopping || this.closed) return;
		this.stopping = true;
		try {
			this.child.stdin.destroy();
		} catch {
			/* The child may have already closed stdin. */
		}
		this.kill("SIGTERM");
		this.killTimer = setTimeout(() => {
			if (!this.closed) this.kill("SIGKILL");
		}, this.killGraceMs);
	}

	private fail(error: Error): void {
		if (this.failure === undefined) {
			this.failure = error;
			this.failureReject?.(error);
		}
		this.stop();
	}

	async race<T>(operation: Promise<T>): Promise<T> {
		if (this.failure) throw this.failure;
		return Promise.race([operation, this.failurePromise]);
	}

	private failInput(error: Error): Error {
		const failure = this.failure ?? new Error(`Git process failed: stdin: ${error.message}`, { cause: error });
		this.fail(failure);
		return failure;
	}

	async write(bytes: Buffer): Promise<void> {
		if (this.failure) throw this.failure;
		await this.race(
			new Promise<void>((resolve, reject) => {
				try {
					this.child.stdin.write(bytes, (error) => {
						if (error) reject(this.failInput(error));
						else resolve();
					});
				} catch (error) {
					reject(this.failInput(error instanceof Error ? error : new Error(String(error))));
				}
			}),
		);
	}

	async endInput(): Promise<void> {
		if (this.failure) throw this.failure;
		await this.race(
			new Promise<void>((resolve, reject) => {
				try {
					this.child.stdin.end((error?: Error | null) => {
						if (error) reject(this.failInput(error));
						else resolve();
					});
				} catch (error) {
					reject(this.failInput(error instanceof Error ? error : new Error(String(error))));
				}
			}),
		);
	}

	async waitForSuccess(context: string): Promise<void> {
		const result = await this.race(this.closePromise);
		if (this.failure) throw this.failure;
		if (result.code !== 0) {
			const diagnostic = this.diagnostic();
			const suffix = diagnostic ? `: ${diagnostic}` : result.signal ? ` (${result.signal})` : "";
			throw new Error(`${context}${suffix}`);
		}
	}

	async stopAndReap(): Promise<void> {
		this.stop();
		if (!this.closed) await this.closePromise;
		this.clearLifecycle();
	}

	diagnostic(): string {
		const text = this.stderr.toString("utf8").trim();
		return this.stderrTruncated ? `${text} [stderr truncated]` : text;
	}
}

class BinaryReader {
	private readonly iterator: AsyncIterator<Buffer>;
	private readonly process: ManagedGitProcess;
	private buffer: Buffer = EMPTY_BUFFER;
	private offset = 0;
	private ended = false;

	constructor(stdout: BinaryReadable, process: ManagedGitProcess) {
		this.iterator = stdout[Symbol.asyncIterator]();
		this.process = process;
	}

	private available(): number {
		return this.buffer.byteLength - this.offset;
	}

	private async pull(): Promise<boolean> {
		if (this.available() > 0) return true;
		if (this.ended) return false;
		const next = await this.process.race(this.iterator.next());
		if (next.done) {
			this.ended = true;
			this.buffer = EMPTY_BUFFER;
			this.offset = 0;
			return false;
		}
		this.buffer = next.value;
		this.offset = 0;
		return this.buffer.byteLength > 0 || this.pull();
	}

	async readLine(maxBytes: number): Promise<Buffer> {
		const parts: Buffer[] = [];
		let total = 0;
		while (await this.pull()) {
			const newline = this.buffer.indexOf(0x0a, this.offset);
			const end = newline === -1 ? this.buffer.byteLength : newline;
			const length = end - this.offset;
			if (total + length > maxBytes) throw new Error(`Git batch header exceeds ${maxBytes} bytes.`);
			if (length > 0) parts.push(this.buffer.subarray(this.offset, end));
			total += length;
			this.offset = newline === -1 ? end : end + 1;
			if (newline !== -1) return Buffer.concat(parts, total);
		}
		throw new Error("Git batch output ended before its header delimiter.");
	}

	async consume(size: number, writeChunk: (chunk: Buffer) => Promise<void>): Promise<void> {
		let remaining = size;
		while (remaining > 0) {
			if (!(await this.pull()))
				throw new Error(`Git batch output was truncated with ${remaining} payload bytes missing.`);
			const length = Math.min(remaining, this.available());
			const chunk = this.buffer.subarray(this.offset, this.offset + length);
			await writeChunk(chunk);
			this.offset += length;
			remaining -= length;
		}
	}

	async readByte(): Promise<number> {
		if (!(await this.pull())) throw new Error("Git batch output ended before its payload delimiter.");
		const byte = this.buffer[this.offset];
		this.offset++;
		return byte;
	}

	async expectEnd(): Promise<void> {
		if (this.available() > 0) throw new Error("Git batch process returned unexpected extra output.");
		while (await this.pull()) {
			if (this.available() > 0) throw new Error("Git batch process returned unexpected extra output.");
		}
	}
}

function parseAscii(buffer: Buffer, label: string): string {
	for (const byte of buffer) {
		if (byte < 0x20 || byte > 0x7e) throw new Error(`Git returned an invalid ${label}.`);
	}
	return buffer.toString("ascii");
}

function parseBatchHeader(header: Buffer): BatchHeader {
	const text = parseAscii(header, "batch header");
	const missing = /^([0-9a-f]{40}) missing$/.exec(text);
	if (missing) throw new Error(`Git batch object ${missing[1]} is missing.`);
	const match = /^([0-9a-f]{40}) ([a-z]+) (\d+)$/.exec(text);
	if (!match) throw new Error("Git returned an invalid batch header.");
	const size = Number(match[3]);
	if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git returned an invalid batch object size.");
	return { objectId: match[1], objectType: match[2], size };
}

function parseTreeRecord(record: Buffer): SnapshotTreeEntry {
	const tab = record.indexOf(0x09);
	if (tab <= 0 || tab === record.byteLength - 1) throw new Error("Git returned invalid PR tree metadata.");
	const metadata = parseAscii(record.subarray(0, tab), "PR tree metadata");
	const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}) +(\d+|-)$/.exec(metadata);
	if (!match) throw new Error("Git returned invalid PR tree metadata.");
	const pathBytes = record.subarray(tab + 1);
	let path: string;
	try {
		path = UTF8_DECODER.decode(pathBytes);
		if (!Buffer.from(path, "utf-8").equals(pathBytes)) {
			throw new Error("Git returned a PR tree path that is not valid UTF-8; this commit snapshot is unsupported.");
		}
	} catch {
		throw new Error("Git returned a PR tree path that is not valid UTF-8; this commit snapshot is unsupported.");
	}
	let size: number | null = null;
	if (match[4] !== "-") {
		size = Number(match[4]);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git returned an invalid PR tree size.");
	}
	return { mode: match[1], objectType: match[2], objectId: match[3], size, path };
}

/** Parse NUL-delimited `ls-tree` bytes without replacement-decoding path names. */
export function parseSnapshotTreeMetadata(
	metadata: Buffer,
	limits: { maxBlobBytes?: number; maxTrackedEntries?: number } = {},
): SnapshotTree {
	const entries: SnapshotTreeEntry[] = [];
	let blobBytes = 0;
	let start = 0;
	while (start < metadata.byteLength) {
		const nul = metadata.indexOf(0x00, start);
		if (nul === -1) throw new Error("Git returned PR tree metadata without a NUL delimiter.");
		if (nul === start) throw new Error("Git returned an empty PR tree metadata record.");
		const entry = parseTreeRecord(metadata.subarray(start, nul));
		entries.push(entry);
		if (limits.maxTrackedEntries !== undefined && entries.length > limits.maxTrackedEntries) {
			throw new Error(
				`Commit snapshot tracked entries (${entries.length}) exceeds the limit (${limits.maxTrackedEntries}).`,
			);
		}
		if (entry.objectType === "blob") {
			if (entry.size === null) throw new Error("Git returned an invalid PR blob size.");
			blobBytes += entry.size;
			if (!Number.isSafeInteger(blobBytes)) throw new Error("The PR tree is too large to measure safely.");
			if (limits.maxBlobBytes !== undefined && blobBytes > limits.maxBlobBytes) {
				throw new Error(
					`Commit snapshot tracked blob bytes (${blobBytes}) exceeds the limit (${limits.maxBlobBytes}).`,
				);
			}
		}
		start = nul + 1;
	}
	return { entries, blobBytes };
}

/** Resolve the authoritative object store through the caller's repository-bound executor. */
export async function resolveSnapshotGitDir(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await exec("git", ["rev-parse", "--absolute-git-dir"], {
		cwd,
		timeout: DEFAULT_GIT_TIMEOUT_MS,
		signal,
	});
	if (result.code !== 0) {
		const diagnostic = (result.stderr || result.stdout).slice(0, STDERR_BYTES).trim();
		throw new Error(`Could not resolve the commit snapshot Git directory${diagnostic ? `: ${diagnostic}` : "."}`);
	}
	const gitDir = result.stdout.replace(/\r?\n$/, "");
	if (!gitDir || !isAbsolute(gitDir) || gitDir.includes("\0")) {
		throw new Error("Git returned an invalid absolute directory for the commit snapshot object store.");
	}
	return gitDir;
}

/** Enumerate one pinned tree through a bounded binary `ls-tree` process. */
export async function readSnapshotTree(options: {
	gitDir: string;
	cwd: string;
	headSha: string;
	signal?: AbortSignal;
	maxMetadataBytes?: number;
	maxBlobBytes?: number;
	maxTrackedEntries?: number;
	process?: SnapshotProcessOptions;
}): Promise<SnapshotTree> {
	const processOptions = options.process ?? {};
	const managed = new ManagedGitProcess(
		gitArgs(options.gitDir, ["ls-tree", "-r", "-z", "-l", "--full-tree", options.headSha]),
		options.cwd,
		processOptions,
	);
	managed.bindSignal(options.signal);
	const chunks: Buffer[] = [];
	let total = 0;
	const maximum = options.maxMetadataBytes ?? DEFAULT_TREE_METADATA_BYTES;
	try {
		await managed.endInput();
		const iterator = managed.child.stdout[Symbol.asyncIterator]();
		while (true) {
			const next = await managed.race(iterator.next());
			if (next.done) break;
			const chunk = next.value;
			total += chunk.byteLength;
			if (!Number.isSafeInteger(total) || total > maximum) {
				throw new Error(`Commit snapshot tree metadata (${total}) exceeds the limit (${maximum}).`);
			}
			chunks.push(chunk);
		}
		await managed.waitForSuccess(`Could not inspect commit snapshot tree ${options.headSha}`);
		return parseSnapshotTreeMetadata(Buffer.concat(chunks, total), {
			maxBlobBytes: options.maxBlobBytes,
			maxTrackedEntries: options.maxTrackedEntries,
		});
	} catch (error) {
		await managed.stopAndReap();
		throw error;
	}
}

class GitBatchObjectReader implements SnapshotObjectReader {
	private readonly managed: ManagedGitProcess;
	private readonly reader: BinaryReader;
	private finished = false;
	private failed = false;

	constructor(options: {
		gitDir: string;
		cwd: string;
		signal?: AbortSignal;
		process?: SnapshotProcessOptions;
	}) {
		this.managed = new ManagedGitProcess(
			gitArgs(options.gitDir, ["cat-file", "--batch"]),
			options.cwd,
			options.process ?? {},
		);
		this.managed.bindSignal(options.signal);
		this.reader = new BinaryReader(this.managed.child.stdout, this.managed);
	}

	async readBlob(blob: SnapshotBlob, writeChunk: (chunk: Buffer) => Promise<void>): Promise<void> {
		if (this.finished || this.failed) throw new Error("Git batch object reader is not available.");
		if (!OBJECT_ID_RE.test(blob.objectId) || !Number.isSafeInteger(blob.size) || blob.size < 0) {
			throw new Error(`Invalid pinned blob metadata for ${JSON.stringify(blob.path)}.`);
		}
		try {
			await this.managed.write(Buffer.from(`${blob.objectId}\n`, "ascii"));
			const response = parseBatchHeader(await this.reader.readLine(BATCH_HEADER_BYTES));
			if (response.objectId !== blob.objectId) {
				throw new Error(
					`Git batch returned object ${response.objectId} for pinned object ${blob.objectId} at ${JSON.stringify(blob.path)}.`,
				);
			}
			if (response.objectType !== "blob") {
				throw new Error(
					`Git batch returned ${response.objectType} for blob ${blob.objectId} at ${JSON.stringify(blob.path)}.`,
				);
			}
			if (response.size !== blob.size) {
				throw new Error(
					`Git batch returned ${response.size} bytes for blob ${blob.objectId} at ${JSON.stringify(blob.path)}; expected ${blob.size}.`,
				);
			}
			await this.reader.consume(response.size, writeChunk);
			if ((await this.reader.readByte()) !== 0x0a) {
				throw new Error(`Git batch returned an invalid payload delimiter for blob ${blob.objectId}.`);
			}
		} catch (error) {
			this.failed = true;
			await this.managed.stopAndReap();
			throw error;
		}
	}

	async finish(): Promise<void> {
		if (this.finished) return;
		if (this.failed) throw new Error("Git batch object reader failed.");
		this.finished = true;
		try {
			await this.managed.endInput();
			await this.reader.expectEnd();
			await this.managed.waitForSuccess("Could not read commit snapshot objects");
		} catch (error) {
			this.failed = true;
			await this.managed.stopAndReap();
			throw error;
		}
	}

	async abort(): Promise<void> {
		if (this.finished && !this.failed) return;
		this.failed = true;
		await this.managed.stopAndReap();
	}
}

/** Start the single binary `cat-file --batch` process for one snapshot. */
export function openSnapshotObjectReader(options: {
	gitDir: string;
	cwd: string;
	signal?: AbortSignal;
	process?: SnapshotProcessOptions;
}): SnapshotObjectReader {
	return new GitBatchObjectReader(options);
}
