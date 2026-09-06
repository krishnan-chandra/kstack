import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import {
	openSnapshotObjectReader,
	parseSnapshotTreeMetadata,
	readSnapshotTree,
	resolveSnapshotGitDir,
	type SnapshotGitSpawn,
	type SnapshotTreeEntry,
} from "./snapshot-objects.ts";

const OID = "1111111111111111111111111111111111111111";
const OTHER_OID = "2222222222222222222222222222222222222222";

function treeRecord(mode: string, objectType: string, objectId: string, size: number | "-", path: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`${mode} ${objectType} ${objectId} ${size}\t`, "ascii"), path, Buffer.from([0])]);
}

function batchFrame(objectId: string, objectType: string, payload: Buffer, declaredSize = payload.byteLength): Buffer {
	return Buffer.concat([
		Buffer.from(`${objectId} ${objectType} ${declaredSize}\n`, "ascii"),
		payload,
		Buffer.from("\n", "ascii"),
	]);
}

class FakeGitChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly kills: Array<NodeJS.Signals | number | undefined> = [];
	private closed = false;
	closeOnSignal: NodeJS.Signals | undefined = "SIGTERM";

	constructor(onInput?: (bytes: Buffer, child: FakeGitChild) => void) {
		super();
		this.stdin.on("data", (chunk: Buffer) => onInput?.(chunk, this));
		this.stdin.on("finish", () => this.close(0));
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.kills.push(signal);
		if (signal === this.closeOnSignal) this.close(null, signal);
		return true;
	}

	close(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.closed) return;
		this.closed = true;
		this.stdout.end();
		this.stderr.end();
		queueMicrotask(() => this.emit("close", code, signal));
	}
}

function spawnOne(child: FakeGitChild, seenArgs?: string[][]): SnapshotGitSpawn {
	return (_command, args) => {
		seenArgs?.push(args);
		return child;
	};
}

function requiredEntry(entries: Map<string, SnapshotTreeEntry>, path: string): SnapshotTreeEntry {
	const found = entries.get(path);
	assert.ok(found);
	return found;
}

function collect(entry: SnapshotTreeEntry, reader: ReturnType<typeof openSnapshotObjectReader>): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	return reader
		.readBlob({ objectId: entry.objectId, size: entry.size ?? -1, path: entry.path }, async (chunk) => {
			total += chunk.byteLength;
			chunks.push(Buffer.from(chunk));
		})
		.then(() => Buffer.concat(chunks, total));
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Buffer {
	const result = spawnSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	assert.equal(result.status, 0, result.stderr.toString("utf8") || result.error?.message);
	return result.stdout;
}

describe("snapshot tree metadata", () => {
	it("parses binary NUL-delimited entries and measures only blob payloads", () => {
		const metadata = Buffer.concat([
			treeRecord("100644", "blob", OID, 3, Buffer.from("line\nname")),
			treeRecord("160000", "commit", OTHER_OID, "-", Buffer.from("submodule")),
		]);
		assert.deepEqual(parseSnapshotTreeMetadata(metadata), {
			blobBytes: 3,
			entries: [
				{ mode: "100644", objectType: "blob", objectId: OID, size: 3, path: "line\nname" },
				{ mode: "160000", objectType: "commit", objectId: OTHER_OID, size: null, path: "submodule" },
			],
		});
	});

	it("rejects invalid UTF-8 names instead of replacement-decoding them", () => {
		const metadata = treeRecord("100644", "blob", OID, 1, Buffer.from([0xff]));
		assert.throws(() => parseSnapshotTreeMetadata(metadata), /not valid UTF-8.*unsupported/);
	});

	it("rejects malformed, unterminated, and unsafe-size metadata", () => {
		assert.throws(() => parseSnapshotTreeMetadata(Buffer.from("bad\0")), /invalid PR tree metadata/);
		assert.throws(
			() => parseSnapshotTreeMetadata(Buffer.from(`100644 blob ${OID} 1\tfile`)),
			/without a NUL delimiter/,
		);
		assert.throws(
			() => parseSnapshotTreeMetadata(treeRecord("100644", "blob", OID, "-", Buffer.from("file"))),
			/invalid PR blob size/,
		);
	});

	it("stops parsing when tracked-byte or recursive-entry budgets are exceeded", () => {
		const metadata = Buffer.concat([
			treeRecord("100644", "blob", OID, 2, Buffer.from("first")),
			treeRecord("160000", "commit", OTHER_OID, "-", Buffer.from("submodule")),
		]);
		assert.throws(
			() => parseSnapshotTreeMetadata(metadata, { maxBlobBytes: 1 }),
			/tracked blob bytes \(2\) exceeds the limit \(1\)/,
		);
		assert.throws(
			() => parseSnapshotTreeMetadata(metadata, { maxTrackedEntries: 1 }),
			/tracked entries \(2\) exceeds the limit \(1\)/,
		);
	});

	it("resolves the Git directory through the supplied repository-bound executor", async () => {
		const calls: string[][] = [];
		const exec: ExecFn = async (command, args, options) => {
			calls.push([command, ...args, options.cwd]);
			return { code: 0, stdout: "/external/jj/store\n", stderr: "" };
		};
		assert.equal(await resolveSnapshotGitDir(exec, "/workspace"), "/external/jj/store");
		assert.deepEqual(calls, [["git", "rev-parse", "--absolute-git-dir", "/workspace"]]);
	});

	it("bounds raw tree metadata and reaps the enumerator", async () => {
		const child = new FakeGitChild();
		child.stdin.removeAllListeners("finish");
		queueMicrotask(() => child.stdout.write(Buffer.alloc(5, 0x61)));
		await assert.rejects(
			readSnapshotTree({
				gitDir: "/store",
				cwd: "/workspace",
				headSha: OID,
				maxMetadataBytes: 4,
				process: { spawn: spawnOne(child), killGraceMs: 5 },
			}),
			/tree metadata \(5\) exceeds the limit \(4\)/,
		);
		assert.deepEqual(child.kills, ["SIGTERM"]);
	});

	it("uses the explicit object store and disables replacement objects", async () => {
		const child = new FakeGitChild();
		const seenArgs: string[][] = [];
		const read = readSnapshotTree({
			gitDir: "/external/store",
			cwd: "/workspace",
			headSha: OID,
			process: { spawn: spawnOne(child, seenArgs) },
		});
		await read;
		assert.deepEqual(seenArgs, [
			["--no-replace-objects", "--git-dir=/external/store", "ls-tree", "-r", "-z", "-l", "--full-tree", OID],
		]);
	});

	it("bounds stderr when tree enumeration fails", async () => {
		const child = new FakeGitChild();
		child.stdin.removeAllListeners("finish");
		queueMicrotask(() => {
			child.stderr.write(Buffer.alloc(9 * 1024, 0x78));
			child.close(1);
		});
		await assert.rejects(
			readSnapshotTree({
				gitDir: "/store",
				cwd: "/workspace",
				headSha: OID,
				process: { spawn: spawnOne(child) },
			}),
			(error: Error) => {
				assert.match(error.message, /stderr truncated/);
				assert.ok(Buffer.byteLength(error.message) < 8.5 * 1024);
				return true;
			},
		);
	});
});

describe("snapshot batch object reader", () => {
	it("streams split binary and empty frames from one real disposable Git process", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-snapshot-objects-"));
		const repo = join(root, "repo");
		const env = createVcsTestEnv(root);
		try {
			mkdirSync(repo);
			run(repo, ["init", "-q"], env);
			const binary = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a]);
			writeFileSync(join(repo, "binary"), binary);
			writeFileSync(join(repo, "shared-a"), binary);
			writeFileSync(join(repo, "empty"), Buffer.alloc(0));
			run(repo, ["add", "."], env);
			run(repo, ["commit", "-qm", "objects"], env);
			const headSha = run(repo, ["rev-parse", "HEAD"], env).toString("ascii").trim();
			const exec: ExecFn = async (_command, args) => ({
				code: 0,
				stdout: run(repo, args, env).toString("utf8"),
				stderr: "",
			});
			const gitDir = await resolveSnapshotGitDir(exec, repo);
			const processArgs: string[][] = [];
			const spawnImpl: SnapshotGitSpawn = (command, args, options) => {
				processArgs.push(args);
				return spawn(command, args, options);
			};
			const tree = await readSnapshotTree({ gitDir, cwd: repo, headSha, process: { spawn: spawnImpl, env } });
			const reader = openSnapshotObjectReader({ gitDir, cwd: repo, process: { spawn: spawnImpl, env } });
			const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
			assert.deepEqual(await collect(requiredEntry(byPath, "binary"), reader), binary);
			assert.deepEqual(await collect(requiredEntry(byPath, "shared-a"), reader), binary);
			assert.deepEqual(await collect(requiredEntry(byPath, "empty"), reader), Buffer.alloc(0));
			await reader.finish();
			assert.equal(processArgs.filter((args) => args.includes("cat-file")).length, 1);
			assert.equal(processArgs.length, 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("consumes split headers and payloads without decoding blob bytes", async () => {
		const payload = Buffer.from([0x00, 0xff, 0xfe, 0x0a]);
		const frame = batchFrame(OID, "blob", payload);
		const child = new FakeGitChild((_request, target) => {
			for (const byte of frame) target.stdout.write(Buffer.from([byte]));
		});
		const reader = openSnapshotObjectReader({
			gitDir: "/store",
			cwd: "/workspace",
			process: { spawn: spawnOne(child) },
		});
		const chunks: Buffer[] = [];
		await reader.readBlob({ objectId: OID, size: payload.byteLength, path: "binary" }, async (chunk) => {
			chunks.push(Buffer.from(chunk));
		});
		await reader.finish();
		assert.deepEqual(Buffer.concat(chunks), payload);
	});

	it("reports synchronous spawn and stdin failures", async () => {
		const failedSpawn: SnapshotGitSpawn = () => {
			throw new Error("spawn denied");
		};
		assert.throws(
			() => openSnapshotObjectReader({ gitDir: "/store", cwd: "/workspace", process: { spawn: failedSpawn } }),
			/Could not start Git: spawn denied/,
		);

		const child = new FakeGitChild((_request, target) => {
			const error = new Error("broken pipe");
			Object.defineProperty(error, "code", { value: "EPIPE" });
			target.stdin.destroy(error);
		});
		const reader = openSnapshotObjectReader({
			gitDir: "/store",
			cwd: "/workspace",
			process: { spawn: spawnOne(child) },
		});
		await assert.rejects(
			reader.readBlob({ objectId: OID, size: 1, path: "file" }, async () => {}),
			/Git stdin failed|broken pipe/,
		);
		assert.deepEqual(child.kills, ["SIGTERM"]);
	});

	it("rejects missing, wrong-ID, wrong-type, and wrong-size responses", async () => {
		const cases: Array<[Buffer, RegExp]> = [
			[Buffer.from(`${OID} missing\n`), /is missing/],
			[batchFrame(OTHER_OID, "blob", Buffer.from("x")), /returned object.*for pinned object/],
			[batchFrame(OID, "tree", Buffer.from("x")), /returned tree for blob/],
			[batchFrame(OID, "blob", Buffer.from("x"), 2), /returned 2 bytes.*expected 1/],
		];
		for (const [frame, expected] of cases) {
			const child = new FakeGitChild((_request, target) => target.stdout.write(frame));
			const reader = openSnapshotObjectReader({
				gitDir: "/store",
				cwd: "/workspace",
				process: { spawn: spawnOne(child) },
			});
			await assert.rejects(
				reader.readBlob({ objectId: OID, size: 1, path: "file" }, async () => {}),
				expected,
			);
			assert.deepEqual(child.kills, ["SIGTERM"]);
		}
	});

	it("rejects overlong headers, truncated payloads, missing delimiters, and extra output", async () => {
		const cases: Array<[Buffer, RegExp, boolean]> = [
			[Buffer.concat([Buffer.alloc(1025, 0x61), Buffer.from("\n")]), /header exceeds 1024 bytes/, false],
			[Buffer.from(`${OID} blob 2\nx`), /truncated with 1 payload bytes missing/, true],
			[Buffer.from(`${OID} blob 1\nx`), /before its payload delimiter/, true],
			[
				Buffer.concat([batchFrame(OID, "blob", Buffer.from("x")), Buffer.from("extra")]),
				/unexpected extra output/,
				false,
			],
		];
		for (const [frame, expected, closeAfterWrite] of cases) {
			const child = new FakeGitChild((_request, target) => {
				target.stdout.write(frame);
				if (closeAfterWrite) target.close(0);
			});
			const reader = openSnapshotObjectReader({
				gitDir: "/store",
				cwd: "/workspace",
				process: { spawn: spawnOne(child) },
			});
			if (expected.source.includes("extra")) {
				await reader.readBlob({ objectId: OID, size: 1, path: "file" }, async () => {});
				await assert.rejects(reader.finish(), expected);
			} else {
				await assert.rejects(
					reader.readBlob(
						{ objectId: OID, size: expected.source.includes("truncated") ? 2 : 1, path: "file" },
						async () => {},
					),
					expected,
				);
			}
		}
	});

	it("closes and reaps the child when a payload sink fails", async () => {
		const child = new FakeGitChild((_request, target) =>
			target.stdout.write(batchFrame(OID, "blob", Buffer.from("data"))),
		);
		const reader = openSnapshotObjectReader({
			gitDir: "/store",
			cwd: "/workspace",
			process: { spawn: spawnOne(child) },
		});
		await assert.rejects(
			reader.readBlob({ objectId: OID, size: 4, path: "file" }, async () => {
				throw new Error("disk full");
			}),
			/disk full/,
		);
		assert.deepEqual(child.kills, ["SIGTERM"]);
	});

	it("honors aborts before a request and during a split payload", async () => {
		const beforeController = new AbortController();
		beforeController.abort();
		const beforeChild = new FakeGitChild();
		const beforeReader = openSnapshotObjectReader({
			gitDir: "/store",
			cwd: "/workspace",
			signal: beforeController.signal,
			process: { spawn: spawnOne(beforeChild) },
		});
		await assert.rejects(
			beforeReader.readBlob({ objectId: OID, size: 1, path: "file" }, async () => {}),
			/aborted/,
		);
		assert.deepEqual(beforeChild.kills, ["SIGTERM"]);

		const duringController = new AbortController();
		const duringChild = new FakeGitChild((_request, target) => {
			target.stdout.write(Buffer.from(`${OID} blob 2\nx`, "ascii"));
		});
		const duringReader = openSnapshotObjectReader({
			gitDir: "/store",
			cwd: "/workspace",
			signal: duringController.signal,
			process: { spawn: spawnOne(duringChild) },
		});
		await assert.rejects(
			duringReader.readBlob({ objectId: OID, size: 2, path: "file" }, async () => {
				duringController.abort();
			}),
			/aborted/,
		);
		assert.deepEqual(duringChild.kills, ["SIGTERM"]);
	});

	it("aborts and escalates to SIGKILL before resolving", async () => {
		const controller = new AbortController();
		const child = new FakeGitChild();
		child.closeOnSignal = "SIGKILL";
		const reader = openSnapshotObjectReader({
			gitDir: "/store",
			cwd: "/workspace",
			signal: controller.signal,
			process: { spawn: spawnOne(child), killGraceMs: 5 },
		});
		const reading = reader.readBlob({ objectId: OID, size: 1, path: "file" }, async () => {});
		controller.abort();
		await assert.rejects(reading, /aborted/);
		assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
	});

	it("times out and reaps an unresponsive child", async () => {
		const child = new FakeGitChild();
		const reader = openSnapshotObjectReader({
			gitDir: "/store",
			cwd: "/workspace",
			process: { spawn: spawnOne(child), timeoutMs: 5, killGraceMs: 5 },
		});
		await assert.rejects(
			reader.readBlob({ objectId: OID, size: 1, path: "file" }, async () => {}),
			/timed out after 5 ms/,
		);
		assert.deepEqual(child.kills, ["SIGTERM"]);
	});
});
