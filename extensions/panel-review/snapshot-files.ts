/** Validate a pinned Git tree and write it beneath a private snapshot root. */

import { chmod, mkdir, open, symlink } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import type { SnapshotBlob, SnapshotObjectReader, SnapshotTreeEntry } from "./snapshot-objects.ts";

const DEFAULT_SYMLINK_TARGET_BYTES = 64 * 1024;

type SnapshotEntry =
	| { kind: "file"; path: string; objectId: string; size: number; mode: 0o600 | 0o700 }
	| { kind: "symlink"; path: string; objectId: string; size: number }
	| { kind: "gitlink"; path: string };

interface SnapshotFilePlan {
	directories: string[];
	files: Array<Extract<SnapshotEntry, { kind: "file" }>>;
	symlinks: Array<Extract<SnapshotEntry, { kind: "symlink" }>>;
}

interface SnapshotFileLimits {
	maxSymlinkTargetBytes?: number;
}

/** Narrow file-handle contract used to test partial writes and cleanup paths. */
export interface SnapshotFileHandle {
	write(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>;
	chmod(mode: number): Promise<void>;
	close(): Promise<void>;
}

/** Filesystem injection boundary for snapshot tree tests. */
export interface SnapshotFileOperations {
	mkdir(path: string, options: { mode: number }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	open(path: string, flags: "wx", mode: number): Promise<SnapshotFileHandle>;
	symlink(target: Buffer, path: string): Promise<void>;
}

const nodeFileOperations: SnapshotFileOperations = {
	mkdir: async (path, options) => {
		await mkdir(path, options);
	},
	chmod: (path, mode) => chmod(path, mode),
	open: (path, flags, mode) => open(path, flags, mode),
	symlink: (target, path) => symlink(target, path),
};

function unsupported(path: string, reason: string): Error {
	return new Error(`Unsupported commit snapshot entry ${JSON.stringify(path)}: ${reason}.`);
}

function isAlreadyExists(error: Error): boolean {
	return "code" in error && error.code === "EEXIST";
}

async function withCollisionError<T>(path: string, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof Error && isAlreadyExists(error)) {
			throw unsupported(path, "the host filesystem reports a filename collision");
		}
		throw error;
	}
}

function validatePath(path: string): string[] {
	if (path.length === 0) throw unsupported(path, "the path is empty");
	if (path.includes("\0")) throw unsupported(path, "the path contains NUL");
	if (isAbsolute(path) || posix.isAbsolute(path)) throw unsupported(path, "absolute paths are not supported");
	const components = path.split("/");
	for (const component of components) {
		if (component.length === 0) throw unsupported(path, "the path contains an empty component");
		if (component === "." || component === "..") {
			throw unsupported(path, "dot and parent traversal components are not supported");
		}
	}
	return components;
}

function supportedEntry(entry: SnapshotTreeEntry, maxSymlinkTargetBytes: number): SnapshotEntry {
	if (entry.mode === "100644" || entry.mode === "100755") {
		if (entry.objectType !== "blob" || entry.size === null) {
			throw unsupported(entry.path, `mode ${entry.mode} must name a sized blob`);
		}
		return {
			kind: "file",
			path: entry.path,
			objectId: entry.objectId,
			size: entry.size,
			mode: entry.mode === "100755" ? 0o700 : 0o600,
		};
	}
	if (entry.mode === "120000") {
		if (entry.objectType !== "blob" || entry.size === null) {
			throw unsupported(entry.path, "mode 120000 must name a sized blob");
		}
		if (entry.size > maxSymlinkTargetBytes) {
			throw unsupported(
				entry.path,
				`symbolic-link target bytes (${entry.size}) exceeds the limit (${maxSymlinkTargetBytes})`,
			);
		}
		return { kind: "symlink", path: entry.path, objectId: entry.objectId, size: entry.size };
	}
	if (entry.mode === "160000") {
		if (entry.objectType !== "commit" || entry.size !== null) {
			throw unsupported(entry.path, "mode 160000 must name a commit without a blob size");
		}
		return { kind: "gitlink", path: entry.path };
	}
	throw unsupported(entry.path, `mode ${entry.mode} and type ${entry.objectType} are not supported`);
}

/** Validate every path, mode, and bounded symlink size before any snapshot entry is written. */
export function planSnapshotFiles(entries: SnapshotTreeEntry[], limits: SnapshotFileLimits = {}): SnapshotFilePlan {
	const maxSymlinkTargetBytes = limits.maxSymlinkTargetBytes ?? DEFAULT_SYMLINK_TARGET_BYTES;
	if (!Number.isSafeInteger(maxSymlinkTargetBytes) || maxSymlinkTargetBytes < 0) {
		throw new Error(`Invalid symbolic-link target byte limit: ${maxSymlinkTargetBytes}.`);
	}
	const nodeKinds = new Map<string, "directory" | "file" | "symlink" | "gitlink">();
	const directoryDepths = new Map<string, number>();
	const trackedPaths = new Set<string>();
	const planned: SnapshotEntry[] = [];
	for (const rawEntry of entries) {
		if (trackedPaths.has(rawEntry.path)) throw unsupported(rawEntry.path, "the tracked path is duplicated");
		trackedPaths.add(rawEntry.path);
		const components = validatePath(rawEntry.path);
		const entry = supportedEntry(rawEntry, maxSymlinkTargetBytes);
		planned.push(entry);

		let parent = "";
		for (let index = 0; index < components.length - 1; index++) {
			parent = parent ? `${parent}/${components[index]}` : components[index];
			const existing = nodeKinds.get(parent);
			if (existing !== undefined && existing !== "directory") {
				throw unsupported(rawEntry.path, `parent ${JSON.stringify(parent)} is a tracked non-directory`);
			}
			nodeKinds.set(parent, "directory");
			directoryDepths.set(parent, index + 1);
		}
		const existing = nodeKinds.get(rawEntry.path);
		if (existing !== undefined) {
			throw unsupported(rawEntry.path, "the path collides with a tracked file or directory");
		}
		nodeKinds.set(rawEntry.path, entry.kind);
		if (entry.kind === "gitlink") directoryDepths.set(rawEntry.path, components.length);
	}

	const directories = [...directoryDepths]
		.sort(([leftPath, leftDepth], [rightPath, rightDepth]) => {
			const depthDifference = leftDepth - rightDepth;
			return depthDifference === 0 ? leftPath.localeCompare(rightPath) : depthDifference;
		})
		.map(([path]) => path);
	return {
		directories,
		files: planned.filter((entry): entry is Extract<SnapshotEntry, { kind: "file" }> => entry.kind === "file"),
		symlinks: planned.filter((entry): entry is Extract<SnapshotEntry, { kind: "symlink" }> => entry.kind === "symlink"),
	};
}

function fullPath(directory: string, path: string): string {
	return join(directory, ...path.split("/"));
}

async function makeExclusiveDirectory(root: string, path: string, operations: SnapshotFileOperations): Promise<void> {
	await withCollisionError(path, async () => {
		const destination = fullPath(root, path);
		await operations.mkdir(destination, { mode: 0o700 });
		await operations.chmod(destination, 0o700);
	});
}

async function openExclusiveFile(
	root: string,
	entry: Extract<SnapshotEntry, { kind: "file" }>,
	operations: SnapshotFileOperations,
): Promise<SnapshotFileHandle> {
	return withCollisionError(entry.path, () => operations.open(fullPath(root, entry.path), "wx", entry.mode));
}

async function writeAll(handle: SnapshotFileHandle, chunk: Buffer): Promise<void> {
	let offset = 0;
	while (offset < chunk.byteLength) {
		const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
		if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
			throw new Error("Snapshot file write returned an invalid byte count.");
		}
		offset += bytesWritten;
	}
}

function blob(entry: Extract<SnapshotEntry, { kind: "file" | "symlink" }>): SnapshotBlob {
	return { objectId: entry.objectId, size: entry.size, path: entry.path };
}

async function writeFileEntry(
	root: string,
	entry: Extract<SnapshotEntry, { kind: "file" }>,
	objects: SnapshotObjectReader,
	operations: SnapshotFileOperations,
): Promise<void> {
	const handle = await openExclusiveFile(root, entry, operations);
	try {
		await objects.readBlob(blob(entry), (chunk) => writeAll(handle, chunk));
		await handle.chmod(entry.mode);
	} finally {
		await handle.close();
	}
}

async function readSymlinkTarget(
	entry: Extract<SnapshotEntry, { kind: "symlink" }>,
	objects: SnapshotObjectReader,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	await objects.readBlob(blob(entry), async (chunk) => {
		total += chunk.byteLength;
		chunks.push(Buffer.from(chunk));
	});
	const target = Buffer.concat(chunks, total);
	if (target.byteLength === 0) throw unsupported(entry.path, "the symbolic-link target is empty");
	if (target.includes(0x00)) throw unsupported(entry.path, "the symbolic-link target contains NUL");
	return target;
}

async function createExclusiveSymlink(
	root: string,
	entry: Extract<SnapshotEntry, { kind: "symlink" }>,
	target: Buffer,
	operations: SnapshotFileOperations,
): Promise<void> {
	await withCollisionError(entry.path, () => operations.symlink(target, fullPath(root, entry.path)));
}

/** Write regular files first, then materialize symbolic links from exact blob bytes. */
export async function materializeSnapshotFiles(options: {
	directory: string;
	plan: SnapshotFilePlan;
	objects?: SnapshotObjectReader;
	operations?: SnapshotFileOperations;
}): Promise<{ symlinkPaths: string[] }> {
	const { plan } = options;
	const operations = options.operations ?? nodeFileOperations;
	for (const directory of plan.directories) await makeExclusiveDirectory(options.directory, directory, operations);
	if ((plan.files.length > 0 || plan.symlinks.length > 0) && options.objects === undefined) {
		throw new Error("Commit snapshot contains blobs but no object reader is available.");
	}
	if (options.objects) {
		for (const entry of plan.files) await writeFileEntry(options.directory, entry, options.objects, operations);
		for (const entry of plan.symlinks) {
			const target = await readSymlinkTarget(entry, options.objects);
			await createExclusiveSymlink(options.directory, entry, target, operations);
		}
	}
	return { symlinkPaths: plan.symlinks.map((entry) => entry.path) };
}
