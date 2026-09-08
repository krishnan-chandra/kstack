import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	discoverSubagentHistory,
	readStableSubagentHistoryFile,
	revalidateSubagentHistoryFile,
} from "./subagent-history-files.ts";
import { richSessionJsonl, sessionJsonl } from "./test-helpers.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TIMESTAMP = "2026-08-11T08:48:02.226Z";
const FILENAME = `2026-08-11T08-48-02-226Z_${ID}.jsonl`;

function fixture() {
	const parent = mkdtempSync(join(tmpdir(), "kstack-subagent-history-files-"));
	const root = join(parent, "subagents");
	const activeRoot = join(root, ".active");
	mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
	const content = richSessionJsonl({ id: ID, timestamp: TIMESTAMP, cwd: "/tmp/synthetic-project" });
	const path = join(root, FILENAME);
	writeFileSync(path, content, { mode: 0o600 });
	return {
		parent,
		root,
		activeRoot,
		path,
		content,
		cleanup: () => rmSync(parent, { recursive: true, force: true }),
	};
}

function lease(root: string, id: string, value: string): string {
	const path = join(root, ".active", `${id}.json`);
	writeFileSync(path, value, { mode: 0o600 });
	return path;
}

describe("retained subagent file discovery", () => {
	it("discovers and parses realistic v3 history without changing source or lease bytes", async () => {
		const fx = fixture();
		const leasePath = lease(
			fx.root,
			OTHER_ID,
			JSON.stringify({ state: "spawned", pid: 99, createdAt: "2026-08-11T08:48:02.226Z" }),
		);
		const before = {
			content: readFileSync(fx.path),
			mode: lstatSync(fx.path).mode,
			lease: readFileSync(leasePath),
			leaseMode: lstatSync(leasePath).mode,
			names: readdirSync(fx.root),
		};
		try {
			const inventory = await discoverSubagentHistory({ root: fx.root, isPidAlive: () => false });
			assert.equal(inventory.complete, true);
			assert.equal(inventory.files.length, 1);
			const result = await readStableSubagentHistoryFile(inventory.files[0], {
				root: fx.root,
				isPidAlive: () => false,
			});
			assert.equal(result.kind, "read");
			if (result.kind === "read") {
				assert.equal(result.parsed.header.id, ID);
				assert.equal(result.name, "archive test session");
				assert.equal(result.parsed.entries.find((entry) => entry.entryId === "u1")?.role, "user");
				assert.equal(result.parsed.entries.find((entry) => entry.entryId === "a1")?.role, "assistant");
				assert.equal(result.parsed.entries.find((entry) => entry.entryId === "t1")?.role, "toolResult");
				assert.equal(result.parsed.entries.find((entry) => entry.entryId === "c1")?.entryType, "compaction");
				for (const entry of result.parsed.entries) {
					const raw = Buffer.from(result.bytes).subarray(entry.rawOffset, entry.rawOffset + entry.rawLength);
					assert.equal(JSON.parse(raw.toString("utf8")).id, entry.entryId);
				}
			}
			assert.deepEqual(readFileSync(fx.path), before.content);
			assert.equal(lstatSync(fx.path).mode, before.mode);
			assert.deepEqual(readFileSync(leasePath), before.lease);
			assert.equal(lstatSync(leasePath).mode, before.leaseMode);
			assert.deepEqual(readdirSync(fx.root), before.names);
		} finally {
			fx.cleanup();
		}
	});

	it("excludes live and recent malformed leases but permits dead and stale leases without deleting them", async () => {
		const fx = fixture();
		const leasePath = lease(
			fx.root,
			ID,
			JSON.stringify({ state: "pending", pid: 123, createdAt: "2026-08-11T08:48:02.226Z" }),
		);
		try {
			let inventory = await discoverSubagentHistory({ root: fx.root, isPidAlive: () => true });
			assert.deepEqual(inventory.activeSessionIds, [ID]);
			assert.equal(inventory.files.length, 0);
			assert.ok(lstatSync(leasePath).isFile());

			inventory = await discoverSubagentHistory({ root: fx.root, isPidAlive: () => false });
			assert.equal(inventory.files.length, 1);
			assert.ok(lstatSync(leasePath).isFile());

			writeFileSync(leasePath, "malformed");
			inventory = await discoverSubagentHistory({ root: fx.root, now: () => Date.now() });
			assert.deepEqual(inventory.activeSessionIds, [ID]);
			const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
			utimesSync(leasePath, old, old);
			inventory = await discoverSubagentHistory({ root: fx.root, now: () => Date.now() });
			assert.equal(inventory.files.length, 1);
			assert.equal(readFileSync(leasePath, "utf8"), "malformed");
		} finally {
			fx.cleanup();
		}
	});

	it("conservatively treats uncertain symlink lease state as active", async () => {
		const fx = fixture();
		const target = join(fx.parent, "lease.json");
		writeFileSync(target, "{}");
		symlinkSync(target, join(fx.activeRoot, `${ID}.json`));
		try {
			const inventory = await discoverSubagentHistory({ root: fx.root });
			assert.deepEqual(inventory.activeSessionIds, [ID]);
			assert.equal(inventory.files.length, 0);
		} finally {
			fx.cleanup();
		}
	});

	it("rejects symlink roots and files, duplicate UUID filenames, and bounded partial enumeration", async () => {
		const fx = fixture();
		const rootLink = join(fx.parent, "root-link");
		symlinkSync(fx.root, rootLink);
		try {
			const linkedRoot = await discoverSubagentHistory({ root: rootLink });
			assert.equal(linkedRoot.complete, false);
			assert.match(linkedRoot.skipped[0]?.reason ?? "", /unsafe/);

			const linkedFile = join(fx.root, `2026-08-11T08-48-03-226Z_${OTHER_ID}.jsonl`);
			symlinkSync(fx.path, linkedFile);
			const withFileLink = await discoverSubagentHistory({ root: fx.root });
			assert.ok(withFileLink.skipped.some((skip) => skip.filename === linkedFile.split("/").at(-1)));
			rmSync(linkedFile);

			const duplicate = join(fx.root, `2026-08-12T08-48-02-226Z_${ID}.jsonl`);
			writeFileSync(duplicate, fx.content);
			const duplicates = await discoverSubagentHistory({ root: fx.root });
			assert.equal(duplicates.files.length, 0);
			assert.equal(duplicates.skipped.filter((skip) => skip.sessionId === ID).length, 2);

			const partial = await discoverSubagentHistory({ root: fx.root, directoryLimit: 1 });
			assert.equal(partial.complete, false);
			assert.equal(partial.inspectedEntries, 1);
		} finally {
			fx.cleanup();
		}
	});
});

describe("stable retained subagent reads", () => {
	it("rejects UUID/header, timestamp, cwd, UTF-8, and size violations", async () => {
		const cases: { content: string | Buffer; expected: RegExp; maxSessionBytes?: number }[] = [
			{ content: sessionJsonl([], { id: OTHER_ID, timestamp: TIMESTAMP, cwd: "/tmp/project" }), expected: /UUID/ },
			{
				content: sessionJsonl([], { id: ID, timestamp: "2026-08-11T08:48:03.226Z", cwd: "/tmp/project" }),
				expected: /timestamp/,
			},
			{ content: sessionJsonl([], { id: ID, timestamp: TIMESTAMP, cwd: "relative" }), expected: /cwd/ },
			{ content: Buffer.from([0xff, 0xfe, 0xfd]), expected: /UTF-8|JSONL/ },
			{
				content: sessionJsonl([], { id: ID, timestamp: TIMESTAMP, cwd: "/tmp/project" }),
				expected: /exceeds/,
				maxSessionBytes: 1,
			},
		];
		for (const testCase of cases) {
			const fx = fixture();
			try {
				writeFileSync(fx.path, testCase.content);
				const inventory = await discoverSubagentHistory({ root: fx.root });
				assert.equal(inventory.files.length, 1);
				const result = await readStableSubagentHistoryFile(inventory.files[0], {
					root: fx.root,
					maxSessionBytes: testCase.maxSessionBytes,
				});
				assert.notEqual(result.kind, "read");
				if (result.kind !== "read") assert.match(result.reason, testCase.expected);
			} finally {
				fx.cleanup();
			}
		}
	});

	it("detects deletion, replacement inode, growth, and a lease created after discovery", async () => {
		const fx = fixture();
		try {
			let inventory = await discoverSubagentHistory({ root: fx.root, isPidAlive: () => true });
			const original = inventory.files[0];
			rmSync(fx.path);
			assert.equal((await revalidateSubagentHistoryFile(original, { root: fx.root })).kind, "unavailable");

			writeFileSync(fx.path, fx.content);
			assert.equal((await revalidateSubagentHistoryFile(original, { root: fx.root })).kind, "changed");

			inventory = await discoverSubagentHistory({ root: fx.root });
			const grown = inventory.files[0];
			writeFileSync(fx.path, `${fx.content}\n`);
			assert.equal((await revalidateSubagentHistoryFile(grown, { root: fx.root })).kind, "changed");

			inventory = await discoverSubagentHistory({ root: fx.root, isPidAlive: () => true });
			const leased = inventory.files[0];
			lease(fx.root, ID, JSON.stringify({ state: "spawned", pid: 123, createdAt: "2026-08-11T08:48:02.226Z" }));
			assert.equal(
				(await readStableSubagentHistoryFile(leased, { root: fx.root, isPidAlive: () => true })).kind,
				"active",
			);
		} finally {
			fx.cleanup();
		}
	});

	it("does not chmod an unreadable source while classifying it", async () => {
		if (process.platform === "win32") return;
		const fx = fixture();
		try {
			const inventory = await discoverSubagentHistory({ root: fx.root });
			const before = lstatSync(fx.path).mode;
			chmodSync(fx.path, 0o000);
			const protectedMode = lstatSync(fx.path).mode;
			await readStableSubagentHistoryFile(inventory.files[0], { root: fx.root });
			assert.equal(lstatSync(fx.path).mode, protectedMode);
			chmodSync(fx.path, before & 0o777);
		} finally {
			fx.cleanup();
		}
	});
});
