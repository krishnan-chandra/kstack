import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { archiveCurrentSession, archiveInactiveSession, type FreshSessionHandle } from "./archive-ops.ts";
import { getSessionRow, openArchiveDb, searchArchive } from "./archive-store.ts";
import { archiveDestination, hashFile } from "./archive-files.ts";
import { sha256Hex } from "./session-jsonl.ts";
import { makeTempTree, richSessionJsonl, sessionJsonl, TEST_SESSION_ID } from "./test-helpers.ts";

const CREATED = "2026-08-11T08:48:02.226Z";

interface FakeCall {
	kind: string;
	detail?: string;
}

function makeFakeCtx(overrides: {
	confirmResult?: boolean;
	newSessionCancelled?: boolean;
	calls?: FakeCall[];
}) {
	const calls: FakeCall[] = overrides.calls ?? [];
	return {
		calls,
		waitForIdle: async () => {
			calls.push({ kind: "waitForIdle" });
		},
		confirm: async (_title: string, message: string) => {
			calls.push({ kind: "confirm", detail: message });
			return overrides.confirmResult ?? true;
		},
		notify: (message: string, level: string) => {
			calls.push({ kind: `notify:${level}`, detail: message });
		},
		startNewSession: async (withSession: (fresh: FreshSessionHandle) => Promise<void>) => {
			calls.push({ kind: "newSession" });
			if (overrides.newSessionCancelled) return { cancelled: true };
			const fresh: FreshSessionHandle = {
				notify: (message, level) => calls.push({ kind: `fresh-notify:${level}`, detail: message }),
			};
			await withSession(fresh);
			return { cancelled: false };
		},
	};
}

function snapshotFor(tree: ReturnType<typeof makeTempTree>, sourcePath: string | undefined) {
	return {
		sourcePath,
		sessionId: TEST_SESSION_ID,
		sessionDir: tree.sessionDir,
		sessionName: "test session",
	};
}

describe("archiveCurrentSession lifecycle", () => {
	it("orders waitForIdle → confirm → DB pending → newSession → move → finalize", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const fake = makeFakeCtx({});

		const result = await archiveCurrentSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			snapshot: snapshotFor(tree, source),
			...fake,
		});

		assert.equal(result.status, "archived");
		const kinds = fake.calls.map((c) => c.kind);
		assert.deepEqual(kinds.slice(0, 3), ["waitForIdle", "confirm", "newSession"]);
		assert.ok(kinds.includes("fresh-notify:info"));

		// File moved out of the active dir, bytes identical, read-only.
		assert.ok(!existsSync(source));
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, CREATED);
		assert.equal(readFileSync(dest, "utf8"), content);
		if (process.platform !== "win32") {
			assert.equal(lstatSync(dest).mode & 0o777, 0o444);
		}
		assert.equal(hashFile(dest).sha256, sha256Hex(content));

		// DB finalized and searchable.
		const db = openArchiveDb(tree.dbPath);
		try {
			const row = getSessionRow(db, TEST_SESSION_ID);
			assert.equal(row?.state, "archived");
			assert.equal(row?.archive_path, dest);
			assert.ok(searchArchive(db, { query: "archiving" }).length > 0);
		} finally {
			db.close();
		}
	});

	it("proves the DB pending import happens before the session switch", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const fake = makeFakeCtx({});
		// Wrap startNewSession to observe DB state at switch time.
		const startNewSession = async (withSession: (fresh: FreshSessionHandle) => Promise<void>) => {
			const db = openArchiveDb(tree.dbPath);
			try {
				assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "pending");
			} finally {
				db.close();
			}
			assert.ok(existsSync(source), "source must not move before newSession");
			return fake.startNewSession(withSession);
		};
		await archiveCurrentSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			snapshot: snapshotFor(tree, source),
			waitForIdle: fake.waitForIdle,
			confirm: fake.confirm,
			notify: fake.notify,
			startNewSession,
		});
	});

	it("does nothing when the user declines confirmation", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const fake = makeFakeCtx({ confirmResult: false });

		const result = await archiveCurrentSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			snapshot: snapshotFor(tree, source),
			...fake,
		});
		assert.equal(result.status, "cancelled");
		assert.ok(existsSync(source));
		assert.ok(!existsSync(tree.dbPath) || (() => {
			const db = openArchiveDb(tree.dbPath);
			try {
				return getSessionRow(db, TEST_SESSION_ID) === undefined;
			} finally {
				db.close();
			}
		})());
		assert.ok(!fake.calls.some((c) => c.kind === "newSession"));
	});

	it("keeps the source active when the session switch is cancelled", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const fake = makeFakeCtx({ newSessionCancelled: true });

		const result = await archiveCurrentSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			snapshot: snapshotFor(tree, source),
			...fake,
		});
		assert.equal(result.status, "cancelled");
		assert.match(result.message, /cancelled/);
		assert.ok(existsSync(source), "source must remain in place");
		const db = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(db, TEST_SESSION_ID), undefined);
		} finally {
			db.close();
		}
	});

	it("keeps the new session and reports recovery when the move fails", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const fake = makeFakeCtx({});

		const result = await archiveCurrentSession({
			deps: {
				dbPath: tree.dbPath,
				archiveRoot: tree.archiveRoot,
				move: () => {
					throw new Error("simulated move failure");
				},
			},
			snapshot: snapshotFor(tree, source),
			...fake,
		});
		assert.equal(result.status, "failed");
		assert.ok(existsSync(source), "complete source copy preserved");
		assert.ok(fake.calls.some((c) => c.kind === "fresh-notify:error" && /finalization failed/.test(c.detail ?? "")));
		const db = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "pending");
		} finally {
			db.close();
		}
	});

	it("rejects ephemeral sessions", async () => {
		const tree = makeTempTree();
		const fake = makeFakeCtx({});
		const result = await archiveCurrentSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			snapshot: snapshotFor(tree, undefined),
			...fake,
		});
		assert.equal(result.status, "rejected");
		assert.match(result.message, /ephemeral/);
	});

	it("rejects header-only sessions", async () => {
		const tree = makeTempTree();
		const source = tree.writeSession(TEST_SESSION_ID, sessionJsonl([]));
		const fake = makeFakeCtx({});
		const result = await archiveCurrentSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			snapshot: snapshotFor(tree, source),
			...fake,
		});
		assert.equal(result.status, "rejected");
		assert.match(result.message, /no entries/);
	});

	it("rejects a session id mismatch between manager and header", async () => {
		const tree = makeTempTree();
		const source = tree.writeSession(TEST_SESSION_ID, richSessionJsonl());
		const fake = makeFakeCtx({});
		const result = await archiveCurrentSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			snapshot: { ...snapshotFor(tree, source), sessionId: "different-id" },
			...fake,
		});
		assert.equal(result.status, "rejected");
		assert.match(result.message, /mismatch/);
	});
});

describe("archiveInactiveSession", () => {
	it("archives an inactive session without any session replacement", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const result = await archiveInactiveSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePath: source,
			sessionDir: tree.sessionDir,
		});
		assert.equal(result.status, "archived");
		assert.ok(!existsSync(source));
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, CREATED);
		assert.equal(readFileSync(dest, "utf8"), content);
		const db = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "archived");
		} finally {
			db.close();
		}
	});

	it("refuses the current session even when it races into the selection", async () => {
		const tree = makeTempTree();
		const source = tree.writeSession(TEST_SESSION_ID, richSessionJsonl());
		const result = await archiveInactiveSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePath: source,
			currentSessionFile: source,
			sessionDir: tree.sessionDir,
		});
		assert.equal(result.status, "rejected");
		assert.ok(existsSync(source));
	});

	it("refuses the current session when its path uses a symlinked directory alias", async () => {
		const tree = makeTempTree();
		const source = tree.writeSession(TEST_SESSION_ID, richSessionJsonl());
		const aliasDir = join(tree.root, "session-alias");
		symlinkSync(tree.sessionDir, aliasDir);
		const result = await archiveInactiveSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePath: source,
			currentSessionFile: join(aliasDir, basename(source)),
			sessionDir: tree.sessionDir,
		});
		assert.equal(result.status, "rejected");
		assert.ok(existsSync(source));
	});

	it("rejects a stale selection whose file vanished", async () => {
		const tree = makeTempTree();
		const result = await archiveInactiveSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePath: `${tree.sessionDir}/gone_x.jsonl`,
			sessionDir: tree.sessionDir,
		});
		assert.equal(result.status, "rejected");
	});

	it("keeps everything in place when the move fails", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const result = await archiveInactiveSession({
			deps: {
				dbPath: tree.dbPath,
				archiveRoot: tree.archiveRoot,
				move: () => {
					throw new Error("disk full");
				},
			},
			sourcePath: source,
			sessionDir: tree.sessionDir,
		});
		assert.equal(result.status, "failed");
		assert.match(result.message, /disk full/);
		assert.ok(existsSync(source));
		const db = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(db, TEST_SESSION_ID)?.state, "pending");
		} finally {
			db.close();
		}
	});

	it("is idempotent when archiving the same session twice", async () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const first = await archiveInactiveSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePath: source,
			sessionDir: tree.sessionDir,
		});
		assert.equal(first.status, "archived");
		// Second attempt: the source is gone, so this is a clean rejection.
		const second = await archiveInactiveSession({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePath: source,
			sessionDir: tree.sessionDir,
		});
		assert.equal(second.status, "rejected");
	});
});
