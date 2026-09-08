import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	materializeSnapshotFiles,
	planSnapshotFiles,
	type SnapshotFileHandle,
	type SnapshotFileOperations,
} from "./snapshot-files.ts";
import type { SnapshotBlob, SnapshotObjectReader, SnapshotTreeEntry } from "./snapshot-objects.ts";

const OID = "1111111111111111111111111111111111111111";
const OTHER_OID = "2222222222222222222222222222222222222222";

function entry(
	path: string,
	options: Partial<Pick<SnapshotTreeEntry, "mode" | "objectType" | "objectId" | "size">> = {},
): SnapshotTreeEntry {
	return {
		mode: options.mode ?? "100644",
		objectType: options.objectType ?? "blob",
		objectId: options.objectId ?? OID,
		size: options.size === undefined ? 1 : options.size,
		path,
	};
}

function readerFor(
	objects: Map<string, Buffer>,
	onRead?: (blob: SnapshotBlob) => void,
): SnapshotObjectReader & { requests: SnapshotBlob[] } {
	const requests: SnapshotBlob[] = [];
	return {
		requests,
		async readBlob(blob, writeChunk) {
			requests.push(blob);
			onRead?.(blob);
			const bytes = objects.get(blob.objectId);
			if (bytes === undefined) throw new Error(`missing fake object ${blob.objectId}`);
			const split = Math.min(2, bytes.byteLength);
			if (split > 0) await writeChunk(bytes.subarray(0, split));
			if (split < bytes.byteLength) await writeChunk(bytes.subarray(split));
		},
		async finish() {},
		async abort() {},
	};
}

function collisionError(): Error {
	const error = new Error("already exists");
	Object.defineProperty(error, "code", { value: "EEXIST" });
	return error;
}

describe("planSnapshotFiles", () => {
	it("rejects absolute, dot, parent, empty-component, and duplicate paths", () => {
		for (const path of ["/absolute", "./dot", "a/../parent", "a//empty"]) {
			assert.throws(() => planSnapshotFiles([entry(path)]), /Unsupported commit snapshot entry/);
		}
		assert.throws(() => planSnapshotFiles([entry("same"), entry("same")]), /tracked path is duplicated/);
	});

	it("treats leading U+FEFF path and ordinary path with same suffix as distinct entries", () => {
		const plan = planSnapshotFiles([entry("file.txt"), entry("\uFEFFfile.txt")]);
		assert.equal(plan.files.length, 2);
	});

	it("rejects file-directory collisions in either tree order", () => {
		assert.throws(() => planSnapshotFiles([entry("parent"), entry("parent/child")]), /tracked non-directory/);
		assert.throws(
			() => planSnapshotFiles([entry("parent/child"), entry("parent")]),
			/collides with a tracked file or directory/,
		);
		assert.throws(
			() =>
				planSnapshotFiles([
					entry("submodule", { mode: "160000", objectType: "commit", size: null }),
					entry("submodule/file"),
				]),
			/tracked non-directory/,
		);
	});

	it("rejects oversized symbolic-link targets from tree metadata", () => {
		assert.throws(
			() => planSnapshotFiles([entry("link", { mode: "120000", size: 4 })], { maxSymlinkTargetBytes: 3 }),
			/symbolic-link target bytes \(4\) exceeds the limit \(3\)/,
		);
		assert.doesNotThrow(() => planSnapshotFiles([entry("link", { mode: "120000", size: 64 * 1024 })]));
		assert.throws(
			() => planSnapshotFiles([entry("link", { mode: "120000", size: 64 * 1024 + 1 })]),
			/symbolic-link target bytes \(65537\) exceeds the limit \(65536\)/,
		);
	});

	it("rejects unsupported modes and mode-type mismatches", () => {
		assert.throws(() => planSnapshotFiles([entry("odd", { mode: "100664" })]), /not supported/);
		assert.throws(() => planSnapshotFiles([entry("file", { objectType: "tree" })]), /must name a sized blob/);
		assert.throws(() => planSnapshotFiles([entry("link", { mode: "120000", size: null })]), /must name a sized blob/);
		assert.throws(
			() => planSnapshotFiles([entry("gitlink", { mode: "160000", objectType: "commit", size: 1 })]),
			/without a blob size/,
		);
	});
});

describe("materializeSnapshotFiles", () => {
	it("writes byte-exact private regular files, executable files, symlinks, and empty gitlink directories", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-snapshot-files-"));
		const binary = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
		const executable = Buffer.from("#!/bin/sh\n", "utf8");
		const target = Buffer.from("nested/binary", "utf8");
		const objects = readerFor(
			new Map([
				[OID, binary],
				[OTHER_OID, executable],
				["3333333333333333333333333333333333333333", target],
			]),
		);
		try {
			const result = await materializeSnapshotFiles({
				directory: root,
				plan: planSnapshotFiles([
					entry("nested/binary", { size: binary.byteLength }),
					entry("script", { mode: "100755", objectId: OTHER_OID, size: executable.byteLength }),
					entry("link", {
						mode: "120000",
						objectId: "3333333333333333333333333333333333333333",
						size: target.byteLength,
					}),
					entry("vendor", { mode: "160000", objectType: "commit", objectId: OTHER_OID, size: null }),
				]),
				objects,
			});
			assert.deepEqual(readFileSync(join(root, "nested", "binary")), binary);
			assert.deepEqual(readFileSync(join(root, "script")), executable);
			assert.equal(statSync(join(root, "nested", "binary")).mode & 0o777, 0o600);
			assert.equal(statSync(join(root, "script")).mode & 0o777, 0o700);
			assert.equal(statSync(join(root, "nested")).mode & 0o777, 0o700);
			assert.equal(statSync(join(root, "vendor")).isDirectory(), true);
			assert.equal(readlinkSync(join(root, "link")), "nested/binary");
			assert.equal(lstatSync(join(root, "link")).isSymbolicLink(), true);
			assert.deepEqual(result.symlinkPaths, ["link"]);
			assert.equal(objects.requests.length, 3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates links only after every regular file is complete", async () => {
		const events: string[] = [];
		const handle: SnapshotFileHandle = {
			async write(_buffer, _offset, length) {
				events.push(`write:${length}`);
				return { bytesWritten: length };
			},
			async chmod() {
				events.push("file-chmod");
			},
			async close() {
				events.push("close");
			},
		};
		const operations: SnapshotFileOperations = {
			async mkdir() {},
			async chmod() {},
			async open() {
				events.push("open");
				return handle;
			},
			async symlink() {
				events.push("symlink");
			},
		};
		const fileBytes = Buffer.from("file");
		const linkBytes = Buffer.from("file");
		const objects = readerFor(
			new Map([
				[OID, fileBytes],
				[OTHER_OID, linkBytes],
			]),
			(blob) => events.push(`read:${blob.path}`),
		);
		await materializeSnapshotFiles({
			directory: "/private/root",
			plan: planSnapshotFiles([
				entry("file", { size: fileBytes.byteLength }),
				entry("link", { mode: "120000", objectId: OTHER_OID, size: linkBytes.byteLength }),
			]),
			objects,
			operations,
		});
		assert.ok(events.indexOf("close") < events.indexOf("read:link"));
		assert.ok(events.indexOf("read:link") < events.indexOf("symlink"));
	});

	it("retries partial file writes until every payload byte is written", async () => {
		const written: number[] = [];
		let output = Buffer.alloc(0);
		const handle: SnapshotFileHandle = {
			async write(buffer, offset, length) {
				const bytesWritten = Math.min(2, length);
				output = Buffer.concat([output, buffer.subarray(offset, offset + bytesWritten)]);
				written.push(bytesWritten);
				return { bytesWritten };
			},
			async chmod() {},
			async close() {},
		};
		const operations: SnapshotFileOperations = {
			async mkdir() {},
			async chmod() {},
			async open() {
				return handle;
			},
			async symlink() {},
		};
		const payload = Buffer.from("abcdef");
		await materializeSnapshotFiles({
			directory: "/private/root",
			plan: planSnapshotFiles([entry("file", { size: payload.byteLength })]),
			objects: readerFor(new Map([[OID, payload]])),
			operations,
		});
		assert.deepEqual(written, [2, 2, 2]);
		assert.deepEqual(output, payload);
	});

	it("closes a partial file when object reading fails", async () => {
		let closed = false;
		const handle: SnapshotFileHandle = {
			async write(_buffer, _offset, length) {
				return { bytesWritten: length };
			},
			async chmod() {},
			async close() {
				closed = true;
			},
		};
		const operations: SnapshotFileOperations = {
			async mkdir() {},
			async chmod() {},
			async open() {
				return handle;
			},
			async symlink() {},
		};
		const objects: SnapshotObjectReader = {
			async readBlob(_blob, writeChunk) {
				await writeChunk(Buffer.from("partial"));
				throw new Error("object read failed");
			},
			async finish() {},
			async abort() {},
		};
		await assert.rejects(
			materializeSnapshotFiles({
				directory: "/private/root",
				plan: planSnapshotFiles([entry("file")]),
				objects,
				operations,
			}),
			/object read failed/,
		);
		assert.equal(closed, true);
	});

	it("preserves opaque symbolic-link bytes and rejects NUL targets", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-snapshot-link-"));
		try {
			const opaqueTarget = Buffer.from([0xff]);
			await materializeSnapshotFiles({
				directory: root,
				plan: planSnapshotFiles([entry("opaque", { mode: "120000", size: opaqueTarget.byteLength })]),
				objects: readerFor(new Map([[OID, opaqueTarget]])),
			});
			assert.deepEqual(readlinkSync(join(root, "opaque"), { encoding: "buffer" }), opaqueTarget);

			const nulTarget = Buffer.from([0x61, 0x00, 0x62]);
			await assert.rejects(
				materializeSnapshotFiles({
					directory: root,
					plan: planSnapshotFiles([entry("nul", { mode: "120000", size: nulTarget.byteLength })]),
					objects: readerFor(new Map([[OID, nulTarget]])),
				}),
				/target contains NUL/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses exclusive creation and reports host filename collisions", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-snapshot-collision-"));
		try {
			writeFileSync(join(root, "File"), "host entry");
			await assert.rejects(
				materializeSnapshotFiles({
					directory: root,
					plan: planSnapshotFiles([entry("File")]),
					objects: readerFor(new Map([[OID, Buffer.from("x")]])),
				}),
				/host filesystem reports a filename collision/,
			);

			const operations: SnapshotFileOperations = {
				async mkdir() {
					throw collisionError();
				},
				async chmod() {},
				async open() {
					throw collisionError();
				},
				async symlink() {
					throw collisionError();
				},
			};
			await assert.rejects(
				materializeSnapshotFiles({ directory: root, plan: planSnapshotFiles([entry("Case/name")]), operations }),
				/host filesystem reports a filename collision/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts an empty tree without an object reader", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-snapshot-empty-"));
		try {
			assert.deepEqual(await materializeSnapshotFiles({ directory: root, plan: planSnapshotFiles([]) }), {
				symlinkPaths: [],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("materializes both ordinary and U+FEFF-prefixed files as distinct entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-snapshot-bom-"));
		try {
			const objects = new Map([
				[OID, Buffer.from("plain")],
				[OTHER_OID, Buffer.from("bom")],
			]);
			const entries = [
				entry("file.txt", { objectId: OID, size: 5 }),
				entry("\uFEFFfile.txt", { objectId: OTHER_OID, size: 3 }),
			];
			const plan = planSnapshotFiles(entries);
			const objectsReader = readerFor(objects);
			await materializeSnapshotFiles({ directory: root, plan, objects: objectsReader });
			assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "plain");
			assert.equal(readFileSync(join(root, "\uFEFFfile.txt"), "utf8"), "bom");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
