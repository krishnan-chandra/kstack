import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { archiveDestination } from "./archive-files.ts";
import {
	beginRestore,
	finalizeArchived,
	getSessionRow,
	importSessionPending,
	openArchiveDb,
	readEntries,
	searchArchive,
} from "./archive-store.ts";
import {
	applyRebuild,
	createRebuildCommand,
	deriveOriginalPath,
	planRebuild,
	type RebuildCandidate,
} from "./rebuild.ts";
import { parseSessionJsonlBytes, sha256Hex } from "./session-jsonl.ts";
import {
	makeTempTree,
	messageEntry,
	richSessionJsonl,
	sessionJsonl,
	TEST_SESSION_ID,
	userMessage,
} from "./test-helpers.ts";

const SECOND_SESSION_ID = "029ff001-deb2-7696-997e-8684026835d1";
const THIRD_SESSION_ID = "039ff001-deb2-7696-997e-8684026835d1";

function writeArtifact(
	tree: ReturnType<typeof makeTempTree>,
	id: string,
	content: string,
	path = archiveDestination(tree.archiveRoot, id, parseSessionJsonlBytes(Buffer.from(content)).header.timestamp),
): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, { mode: 0o444 });
	chmodSync(path, 0o444);
	return path;
}

function candidateFrom(path: string): RebuildCandidate {
	const bytes = readFileSync(path);
	const parsed = parseSessionJsonlBytes(bytes);
	return {
		sessionId: parsed.header.id,
		artifactPath: path,
		fileSize: bytes.length,
		sha256: sha256Hex(bytes),
		header: parsed.header,
		entries: parsed.entries,
	};
}

function importPending(dbPath: string, candidate: RebuildCandidate): void {
	const db = openArchiveDb(dbPath);
	try {
		importSessionPending(db, {
			header: candidate.header,
			entries: candidate.entries,
			originalPath: `/active/${candidate.sessionId}.jsonl`,
			archivePath: candidate.artifactPath,
			fileSize: candidate.fileSize,
			sha256: candidate.sha256,
		});
	} finally {
		db.close();
	}
}

function applyPlan(tree: ReturnType<typeof makeTempTree>, plan: ReturnType<typeof planRebuild>) {
	const db = openArchiveDb(tree.dbPath);
	try {
		return applyRebuild(db, plan, (header) => deriveOriginalPath(join(tree.agentDir, "sessions"), header));
	} finally {
		db.close();
	}
}

describe("session archive rebuild", () => {
	it("indexes valid artifacts into a fresh DB, restores FTS and offsets, and is idempotent", () => {
		const tree = makeTempTree();
		const first = richSessionJsonl();
		const second = sessionJsonl([messageEntry("u2", null, userMessage("second rebuild marker"))], {
			id: SECOND_SESSION_ID,
			timestamp: "2026-09-12T10:11:12.123Z",
			cwd: "/Users/test/Code/other",
		});
		const firstPath = writeArtifact(tree, TEST_SESSION_ID, first);
		const secondPath = writeArtifact(tree, SECOND_SESSION_ID, second);

		// A backup-recovered artifact can lose the archive's read-only mode; rebuild restores it.
		chmodSync(firstPath, 0o644);

		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.deepEqual(
			plan.toIndex.map((candidate) => candidate.sessionId).sort(),
			[TEST_SESSION_ID, SECOND_SESSION_ID].sort(),
		);
		assert.deepEqual(plan.invalid, []);

		const result = applyPlan(tree, plan);
		assert.deepEqual(result.failed, []);
		assert.equal(result.indexed.length, 2);

		const db = openArchiveDb(tree.dbPath);
		try {
			for (const [id, path, content] of [
				[TEST_SESSION_ID, firstPath, first],
				[SECOND_SESSION_ID, secondPath, second],
			] as const) {
				const row = getSessionRow(db, id);
				assert.equal(row?.state, "archived");
				assert.equal(row?.archive_path, path);
				assert.equal(row?.sha256, sha256Hex(content));
				assert.equal(row?.file_size, Buffer.byteLength(content));
				assert.ok(readEntries(db, id, 0, 200).length > 0);
			}
			assert.equal(searchArchive(db, { query: "rebuild" }).length, 1);
		} finally {
			db.close();
		}
		assert.equal(readFileSync(firstPath, "utf8"), first);
		assert.equal(readFileSync(secondPath, "utf8"), second);
		if (process.platform !== "win32") {
			assert.equal(lstatSync(firstPath).mode & 0o777, 0o444);
			assert.equal(lstatSync(secondPath).mode & 0o777, 0o444);
		}

		const rerun = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.deepEqual(rerun.toIndex, []);
		assert.deepEqual(rerun.alreadyIndexed.sort(), [TEST_SESSION_ID, SECOND_SESSION_ID].sort());
	});

	it("isolates apply failures so a changed artifact does not block the remaining candidates", () => {
		const tree = makeTempTree();
		const first = richSessionJsonl();
		const second = sessionJsonl([messageEntry("u2", null, userMessage("surviving rebuild"))], {
			id: SECOND_SESSION_ID,
			timestamp: "2026-09-12T10:11:12.123Z",
		});
		const firstPath = writeArtifact(tree, TEST_SESSION_ID, first);
		writeArtifact(tree, SECOND_SESSION_ID, second);
		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		chmodSync(firstPath, 0o644);
		writeFileSync(firstPath, `${first} `);
		chmodSync(firstPath, 0o444);

		const result = applyPlan(tree, plan);
		assert.deepEqual(result.indexed, [SECOND_SESSION_ID]);
		assert.equal(result.failed.length, 1);
		assert.equal(result.failed[0].sessionId, TEST_SESSION_ID);
		assert.match(result.failed[0].error, /changed after/);
	});

	it("reports changed bytes as a conflict and leaves the existing row untouched", () => {
		const tree = makeTempTree();
		const original = richSessionJsonl();
		const path = writeArtifact(tree, TEST_SESSION_ID, original);
		const initialPlan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		applyPlan(tree, initialPlan);
		const db = openArchiveDb(tree.dbPath);
		let originalHash: string;
		try {
			originalHash = getSessionRow(db, TEST_SESSION_ID)?.sha256 ?? "";
		} finally {
			db.close();
		}

		const changed = richSessionJsonl({ cwd: "/Users/test/Code/changed" });
		chmodSync(path, 0o644);
		writeFileSync(path, changed);
		chmodSync(path, 0o444);
		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.equal(plan.conflicts.length, 1);
		assert.deepEqual(plan.toIndex, []);
		applyPlan(tree, plan);

		const verifyDb = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(verifyDb, TEST_SESSION_ID)?.sha256, originalHash);
		} finally {
			verifyDb.close();
		}
	});

	it("reports pending and restore-journal rows for reconciliation without changing them", () => {
		const tree = makeTempTree();
		const pendingContent = richSessionJsonl();
		const pendingPath = writeArtifact(tree, TEST_SESSION_ID, pendingContent);
		const pending = candidateFrom(pendingPath);
		importPending(tree.dbPath, pending);

		const restoreContent = sessionJsonl([messageEntry("u3", null, userMessage("restore journal"))], {
			id: THIRD_SESSION_ID,
			timestamp: "2026-10-01T00:00:00.000Z",
		});
		const restorePath = writeArtifact(tree, THIRD_SESSION_ID, restoreContent);
		const restore = candidateFrom(restorePath);
		importPending(tree.dbPath, restore);
		const db = openArchiveDb(tree.dbPath);
		try {
			finalizeArchived(db, restore.sessionId, restore.artifactPath, restore.fileSize, restore.sha256);
			beginRestore(db, restore.sessionId);
		} finally {
			db.close();
		}

		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.deepEqual(
			plan.needsReconcile.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
			[
				{ sessionId: pending.sessionId, state: "pending" },
				{ sessionId: restore.sessionId, state: "restore" },
			].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
		);
		applyPlan(tree, plan);
		const verifyDb = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(verifyDb, pending.sessionId)?.state, "pending");
			assert.equal(getSessionRow(verifyDb, restore.sessionId)?.state, "archived");
		} finally {
			verifyDb.close();
		}
	});

	it("reports a directory/header id mismatch as invalid", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		writeArtifact(
			tree,
			SECOND_SESSION_ID,
			content,
			join(tree.archiveRoot, "sessions", "2026", "08", SECOND_SESSION_ID, "session.jsonl"),
		);
		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.equal(plan.invalid.length, 1);
		assert.match(plan.invalid[0].reason, /does not match/);
	});

	it("reports malformed JSONL while still indexing other artifacts", () => {
		const tree = makeTempTree();
		const malformedPath = join(tree.archiveRoot, "sessions", "2026", "08", SECOND_SESSION_ID, "session.jsonl");
		mkdirSync(dirname(malformedPath), { recursive: true });
		writeFileSync(malformedPath, "not-json\n");
		const valid = richSessionJsonl();
		writeArtifact(tree, TEST_SESSION_ID, valid);
		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.equal(plan.invalid.length, 1);
		assert.equal(plan.toIndex.length, 1);
		assert.deepEqual(applyPlan(tree, plan).indexed, [TEST_SESSION_ID]);
	});

	it("reports an artifact stored outside its canonical year/month", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const id = TEST_SESSION_ID;
		writeArtifact(tree, id, content, join(tree.archiveRoot, "sessions", "2025", "12", id, "session.jsonl"));
		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.equal(plan.invalid.length, 1);
		assert.match(plan.invalid[0].reason, /canonical destination/);
	});

	it("recreates a deleted SQLite index from intact artifacts", () => {
		const tree = makeTempTree();
		const db = openArchiveDb(tree.dbPath);
		db.close();
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${tree.dbPath}${suffix}`, { force: true });
		assert.equal(existsSync(tree.dbPath), false);
		const content = richSessionJsonl();
		writeArtifact(tree, TEST_SESSION_ID, content);

		const plan = planRebuild({ archiveRoot: tree.archiveRoot, dbPath: tree.dbPath });
		assert.equal(plan.toIndex.length, 1);
		assert.deepEqual(applyPlan(tree, plan).failed, []);
		const rebuilt = openArchiveDb(tree.dbPath);
		try {
			assert.equal(searchArchive(rebuilt, { query: "archiving" }).length > 0, true);
		} finally {
			rebuilt.close();
		}
	});

	it("derives the same default path convention as SessionManager", () => {
		const tree = makeTempTree();
		const cwd = join(tree.root, "Code", "project:one");
		mkdirSync(cwd, { recursive: true });
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tree.agentDir;
		try {
			const manager = SessionManager.create(cwd, undefined, { id: SECOND_SESSION_ID });
			const header = manager.getHeader();
			assert.ok(header);
			assert.equal(deriveOriginalPath(join(tree.agentDir, "sessions"), header), manager.getSessionFile());
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("requires confirmation before applying a rebuild and reports bounded category totals", async () => {
		const candidate = candidateFrom(writeArtifact(makeTempTree(), TEST_SESSION_ID, richSessionJsonl()));
		let applied = false;
		const notifications: string[] = [];
		const command = createRebuildCommand({
			archiveRoot: "/archive",
			activeSessionsRoot: "/sessions",
			dbPath: "/archive/archive.sqlite3",
			planRebuild: () => ({
				toIndex: [candidate],
				alreadyIndexed: [],
				conflicts: [{ sessionId: SECOND_SESSION_ID, artifactPath: "/conflict", reason: "different hash" }],
				needsReconcile: [],
				invalid: [],
			}),
			openArchiveDb: () =>
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ({
					close() {},
				}) as never,
			applyRebuild: () => {
				applied = true;
				return { indexed: [candidate.sessionId], failed: [] };
			},
		});
		await command("", {
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				confirm: async (_title, summary) => {
					assert.match(summary, /1 to index/);
					assert.match(summary, /1 conflict/);
					return false;
				},
				notify: (message) => notifications.push(message),
			},
		});
		assert.equal(applied, false);
		assert.deepEqual(notifications, []);
	});
});
