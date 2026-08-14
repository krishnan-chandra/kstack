import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { archiveDestination } from "./archive-files.ts";
import { finalizeArchived, getSessionRow, importSessionPending, openArchiveDb } from "./archive-store.ts";
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
		writeFileSync(source, content + "extra line\n");

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
