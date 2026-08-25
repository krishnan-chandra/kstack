import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { archiveDestination, fileStat, hashFile } from "./archive-files.ts";
import {
	beginRestore,
	finalizeArchived,
	getSessionRow,
	importSessionPending,
	listRestoreJournals,
	openArchiveDb,
} from "./archive-store.ts";
import { inspectArchiveIntegrity, reconcileArchive } from "./reconcile.ts";
import { parseSessionJsonl, sha256Hex } from "./session-jsonl.ts";
import { makeTempTree, richSessionJsonl, TEST_SESSION_ID } from "./test-helpers.ts";

const CREATED = "2026-08-11T08:48:02.226Z";

function setupPending(tree: ReturnType<typeof makeTempTree>, content: string) {
	const parsed = parseSessionJsonl(content);
	const source = tree.writeSession(TEST_SESSION_ID, content);
	const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, CREATED);
	const db = openArchiveDb(tree.dbPath);
	importSessionPending(db, {
		header: parsed.header,
		entries: parsed.entries,
		originalPath: source,
		archivePath: dest,
		fileSize: content.length,
		sha256: sha256Hex(content),
	});
	db.close();
	return { source, dest, sha256: sha256Hex(content), size: content.length };
}

describe("reconcileArchive", () => {
	it("recovers a restore journal after an earlier recovery marked its catalog row as error", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		unlinkSync(source);
		const db = openArchiveDb(tree.dbPath);
		finalizeArchived(db, TEST_SESSION_ID, dest, content.length, sha256Hex(content));
		beginRestore(db, TEST_SESSION_ID);
		db.close();
		unlinkSync(dest);

		const failed = reconcileArchive({ dbPath: tree.dbPath });
		assert.equal(failed.errors.length, 1);
		writeFileSync(source, content);
		if (process.platform !== "win32") chmodSync(source, 0o444);
		const recovered = reconcileArchive({ dbPath: tree.dbPath });
		assert.deepEqual(recovered.restored, [TEST_SESSION_ID]);
		assert.equal(readFileSync(source, "utf8"), content);
		if (process.platform !== "win32") assert.equal(lstatSync(source).mode & 0o777, 0o600);
		const recoveredDb = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(recoveredDb, TEST_SESSION_ID), undefined);
			assert.deepEqual(listRestoreJournals(recoveredDb), []);
		} finally {
			recoveredDb.close();
		}
	});

	it("leaves pending rows alone when only the source exists", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source } = setupPending(tree, content);
		const report = reconcileArchive({ dbPath: tree.dbPath });
		assert.equal(report.finalized.length, 0);
		assert.equal(report.leftPending.length, 1);
		assert.ok(existsSync(source));
		const db = openArchiveDb(tree.dbPath);
		assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "pending");
		db.close();
	});

	it("finalizes when the destination exists, the source is gone, and the hash matches", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		// Simulate: move happened, finalize did not.
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		unlinkSync(source);

		const report = reconcileArchive({ dbPath: tree.dbPath });
		assert.deepEqual(report.finalized, [TEST_SESSION_ID]);
		const db = openArchiveDb(tree.dbPath);
		const row = getSessionRow(db, TEST_SESSION_ID);
		assert.equal(row?.state, "archived");
		assert.equal(row?.archive_path, dest);
		db.close();
		if (process.platform !== "win32") {
			assert.equal(lstatSync(dest).mode & 0o777, 0o444);
		}
	});

	it("removes a duplicate source and finalizes when both copies match", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);

		const report = reconcileArchive({ dbPath: tree.dbPath });
		assert.deepEqual(report.finalized, [TEST_SESSION_ID]);
		assert.ok(!existsSync(source));
		assert.ok(existsSync(dest));
	});

	it("never removes the source when it is the current session file", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);

		const report = reconcileArchive({ dbPath: tree.dbPath, currentSessionFile: source });
		assert.equal(report.finalized.length, 0);
		assert.equal(report.leftPending.length, 1);
		assert.match(report.leftPending[0].message, /currently active/);
		assert.ok(existsSync(source));
		assert.ok(existsSync(dest));
	});

	it("never removes the current source when its path uses a symlinked directory alias", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		const aliasDir = join(tree.root, "session-alias");
		symlinkSync(tree.sessionDir, aliasDir);

		const report = reconcileArchive({
			dbPath: tree.dbPath,
			currentSessionFile: join(aliasDir, basename(source)),
		});
		assert.equal(report.finalized.length, 0);
		assert.equal(report.leftPending.length, 1);
		assert.ok(existsSync(source));
	});

	it("marks error when both copies are missing and deletes nothing", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source } = setupPending(tree, content);
		unlinkSync(source);

		const report = reconcileArchive({ dbPath: tree.dbPath });
		assert.equal(report.errors.length, 1);
		const db = openArchiveDb(tree.dbPath);
		assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "error");
		db.close();
	});

	it("marks error on destination hash mismatch and preserves both copies", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, "corrupted bytes");

		const report = reconcileArchive({ dbPath: tree.dbPath });
		assert.equal(report.errors.length, 1);
		assert.match(report.errors[0].message, /hash mismatch/);
		assert.ok(existsSync(source));
		assert.equal(readFileSync(dest, "utf8"), "corrupted bytes");
	});

	it("marks error when source and destination differ", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		writeFileSync(source, `${content}extra line\n`);

		const report = reconcileArchive({ dbPath: tree.dbPath });
		assert.equal(report.errors.length, 1);
		assert.ok(existsSync(source));
		assert.ok(existsSync(dest));
	});

	it("does not inspect finalized archive files during startup reconciliation", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { dest, sha256, size } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		const db = openArchiveDb(tree.dbPath);
		finalizeArchived(db, TEST_SESSION_ID, dest, size, sha256);
		db.close();
		unlinkSync(dest);

		reconcileArchive({ dbPath: tree.dbPath });
		const db2 = openArchiveDb(tree.dbPath);
		assert.equal(getSessionRow(db2, TEST_SESSION_ID)?.state, "archived");
		db2.close();
	});

	it("exposes archived integrity details through the read-only inspector", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { dest, sha256, size } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		const db = openArchiveDb(tree.dbPath);
		finalizeArchived(db, TEST_SESSION_ID, dest, size, sha256);
		db.close();
		writeFileSync(dest, "drifted");

		const issues = inspectArchiveIntegrity(tree.dbPath);
		assert.deepEqual(
			issues.map((issue) => issue.sessionId),
			[TEST_SESSION_ID],
		);
		assert.match(issues[0].message, /hash mismatch/);
	});

	it("is idempotent across repeated runs", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const { source, dest } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		unlinkSync(source);

		reconcileArchive({ dbPath: tree.dbPath });
		const second = reconcileArchive({ dbPath: tree.dbPath });
		assert.equal(second.finalized.length, 0);
		assert.equal(second.errors.length, 0);
	});

	it("bounds work per run", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		setupPending(tree, content);
		const secondContent = richSessionJsonl({ id: "aaaaaaaa-1111-4222-8333-444444444444" });
		const parsed2 = parseSessionJsonl(secondContent);
		const source2 = tree.writeSession(parsed2.header.id, secondContent, "2026-08-11T09-00-00-000Z");
		const db = openArchiveDb(tree.dbPath);
		importSessionPending(db, {
			header: parsed2.header,
			entries: parsed2.entries,
			originalPath: source2,
			archivePath: archiveDestination(tree.archiveRoot, parsed2.header.id, CREATED),
			fileSize: secondContent.length,
			sha256: sha256Hex(secondContent),
		});
		db.close();

		const report = reconcileArchive({ dbPath: tree.dbPath, pendingLimit: 1 });
		assert.equal(report.leftPending.length + report.finalized.length + report.errors.length, 1);
	});
});

describe("inspectArchiveIntegrity caching", () => {
	function setupArchived(tree: ReturnType<typeof makeTempTree>, content: string = richSessionJsonl()) {
		const { dest, sha256, size } = setupPending(tree, content);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		const db = openArchiveDb(tree.dbPath);
		finalizeArchived(db, TEST_SESSION_ID, dest, size, sha256);
		db.close();
		return { dest, sha256, size, content };
	}

	it("hashes and marks verified on first inspection", () => {
		const tree = makeTempTree();
		setupArchived(tree);

		let hashCalls = 0;
		const issues = inspectArchiveIntegrity(tree.dbPath, {
			hashFile: (path) => {
				hashCalls++;
				return hashFile(path);
			},
			now: () => 1700000000000,
		});

		assert.equal(issues.length, 0);
		assert.equal(hashCalls, 1);

		const db = openArchiveDb(tree.dbPath);
		const row = getSessionRow(db, TEST_SESSION_ID);
		assert.equal(row?.verified_at, 1700000000000);
		assert.ok(row?.verified_mtime_ms !== null && row.verified_mtime_ms > 0);
		db.close();
	});

	it("skips hashing on second inspection when file is unchanged", () => {
		const tree = makeTempTree();
		setupArchived(tree);

		inspectArchiveIntegrity(tree.dbPath, { now: () => 1700000000000 });

		let hashCalls = 0;
		const issues = inspectArchiveIntegrity(tree.dbPath, {
			hashFile: (path) => {
				hashCalls++;
				return hashFile(path);
			},
			now: () => 1700000005000,
		});

		assert.equal(issues.length, 0);
		assert.equal(hashCalls, 0);
	});

	it("forces a re-hash when file is touched (bumped mtime) and re-marks verified on match", () => {
		const tree = makeTempTree();
		const { dest } = setupArchived(tree);

		inspectArchiveIntegrity(tree.dbPath, { now: () => 1700000000000 });

		const futureTime = new Date(Date.now() + 60000);
		utimesSync(dest, futureTime, futureTime);

		let hashCalls = 0;
		const issues = inspectArchiveIntegrity(tree.dbPath, {
			hashFile: (path) => {
				hashCalls++;
				return hashFile(path);
			},
			now: () => 1700000010000,
		});

		assert.equal(issues.length, 0);
		assert.equal(hashCalls, 1);

		const db = openArchiveDb(tree.dbPath);
		const row = getSessionRow(db, TEST_SESSION_ID);
		assert.equal(row?.verified_at, 1700000010000);
		assert.equal(row?.verified_mtime_ms, fileStat(dest).mtimeMs);
		db.close();

		let repeatHashCalls = 0;
		const repeatIssues = inspectArchiveIntegrity(tree.dbPath, {
			hashFile: (path) => {
				repeatHashCalls++;
				return hashFile(path);
			},
		});
		assert.equal(repeatIssues.length, 0);
		assert.equal(repeatHashCalls, 0);
	});

	it("reports drift issue on rewritten content and leaves verification stale so next run re-hashes", () => {
		const tree = makeTempTree();
		const { dest } = setupArchived(tree);

		inspectArchiveIntegrity(tree.dbPath, { now: () => 1700000000000 });

		const db = openArchiveDb(tree.dbPath);
		const initialVerifiedAt = getSessionRow(db, TEST_SESSION_ID)?.verified_at;
		db.close();
		assert.equal(initialVerifiedAt, 1700000000000);

		writeFileSync(dest, "different content with different bytes");

		let hashCalls = 0;
		const issues = inspectArchiveIntegrity(tree.dbPath, {
			hashFile: (path) => {
				hashCalls++;
				return hashFile(path);
			},
			now: () => 1700000020000,
		});

		assert.equal(issues.length, 1);
		assert.equal(issues[0].sessionId, TEST_SESSION_ID);
		assert.match(issues[0].message, /hash mismatch/);
		assert.equal(hashCalls, 1);

		const db2 = openArchiveDb(tree.dbPath);
		const afterRow = getSessionRow(db2, TEST_SESSION_ID);
		assert.equal(afterRow?.verified_at, 1700000000000);
		db2.close();

		let nextHashCalls = 0;
		const nextIssues = inspectArchiveIntegrity(tree.dbPath, {
			hashFile: (path) => {
				nextHashCalls++;
				return hashFile(path);
			},
		});
		assert.equal(nextIssues.length, 1);
		assert.equal(nextHashCalls, 1);
	});

	it("reports missing file when archive file does not exist", () => {
		const tree = makeTempTree();
		const { dest } = setupArchived(tree);
		unlinkSync(dest);

		let hashCalls = 0;
		const issues = inspectArchiveIntegrity(tree.dbPath, {
			hashFile: (path) => {
				hashCalls++;
				return hashFile(path);
			},
		});

		assert.equal(issues.length, 1);
		assert.equal(issues[0].sessionId, TEST_SESSION_ID);
		assert.match(issues[0].message, /missing/);
		assert.equal(hashCalls, 0);
	});

	it("forces re-hash on sub-millisecond mtime change", () => {
		const tree = makeTempTree();
		const { size } = setupArchived(tree);

		let currentMtime = 1700000000000.1;
		let hashCalls = 0;

		// First inspection: records verified_mtime_ms with sub-millisecond precision
		inspectArchiveIntegrity(tree.dbPath, {
			fileStat: () => ({ size, mtimeMs: currentMtime }),
			hashFile: (path) => {
				hashCalls++;
				return hashFile(path);
			},
			now: () => 1700000000000,
		});
		assert.equal(hashCalls, 1);

		const db = openArchiveDb(tree.dbPath);
		const row = getSessionRow(db, TEST_SESSION_ID);
		assert.equal(row?.verified_mtime_ms, 1700000000000.1);
		db.close();

		// Second inspection with identical sub-ms mtime: skips hash
		let cachedHashCalls = 0;
		inspectArchiveIntegrity(tree.dbPath, {
			fileStat: () => ({ size, mtimeMs: currentMtime }),
			hashFile: (path) => {
				cachedHashCalls++;
				return hashFile(path);
			},
		});
		assert.equal(cachedHashCalls, 0);

		// Sub-millisecond mtime change (same integer ms, different fractional part)
		currentMtime = 1700000000000.8;
		let subMsHashCalls = 0;
		const issues = inspectArchiveIntegrity(tree.dbPath, {
			fileStat: () => ({ size, mtimeMs: currentMtime }),
			hashFile: (path) => {
				subMsHashCalls++;
				return hashFile(path);
			},
			now: () => 1700000010000,
		});
		assert.equal(issues.length, 0);
		assert.equal(subMsHashCalls, 1);

		const db2 = openArchiveDb(tree.dbPath);
		const row2 = getSessionRow(db2, TEST_SESSION_ID);
		assert.equal(row2?.verified_mtime_ms, 1700000000000.8);
		assert.equal(row2?.verified_at, 1700000010000);
		db2.close();
	});

	it("reports unreadable file when stat fails with a non-ENOENT error", () => {
		const tree = makeTempTree();
		setupArchived(tree);

		let hashCalls = 0;
		const issues = inspectArchiveIntegrity(tree.dbPath, {
			fileStat: () => {
				const err = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ new Error(
					"permission denied",
				) as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			},
			hashFile: (path) => {
				hashCalls++;
				return hashFile(path);
			},
		});

		assert.equal(issues.length, 1);
		assert.equal(issues[0].sessionId, TEST_SESSION_ID);
		assert.match(issues[0].message, /could not be verified: permission denied/);
		assert.equal(hashCalls, 0);
	});
});
