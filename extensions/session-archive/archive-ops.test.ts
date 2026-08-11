import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	archiveCurrentSession,
	archiveInactiveSession,
	archiveInactiveSessions,
	type FreshSessionHandle,
} from "./archive-ops.ts";
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

describe("archiveInactiveSessions", () => {
	const ID_A = "019ff002-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
	const ID_B = "019ff003-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
	const ID_C = "019ff004-cccc-7ccc-8ccc-cccccccccccc";

	function writeThree(tree: ReturnType<typeof makeTempTree>) {
		const a = tree.writeSession(ID_A, richSessionJsonl({ id: ID_A }));
		const b = tree.writeSession(ID_B, richSessionJsonl({ id: ID_B }));
		const c = tree.writeSession(ID_C, richSessionJsonl({ id: ID_C }));
		return [a, b, c];
	}

	it("archives every candidate in one batch", async () => {
		const tree = makeTempTree();
		const sources = writeThree(tree);
		const outcomes = await archiveInactiveSessions({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePaths: sources,
			sessionDir: tree.sessionDir,
		});
		assert.equal(outcomes.length, 3);
		assert.ok(outcomes.every((o) => o.result.status === "archived"));
		assert.ok(sources.every((s) => !existsSync(s)));
		const db = openArchiveDb(tree.dbPath);
		try {
			for (const id of [ID_A, ID_B, ID_C]) {
				assert.equal(getSessionRow(db, id)?.state, "archived");
			}
		} finally {
			db.close();
		}
	});

	it("reports progress for every session in order", async () => {
		const tree = makeTempTree();
		const sources = writeThree(tree);
		const progress: Array<[number, number, string]> = [];
		await archiveInactiveSessions({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePaths: sources,
			sessionDir: tree.sessionDir,
			onProgress: (done, total, outcome) => progress.push([done, total, outcome.result.status]),
		});
		assert.deepEqual(progress, [
			[1, 3, "archived"],
			[2, 3, "archived"],
			[3, 3, "archived"],
		]);
	});

	it("continues past malformed and empty sessions without losing them", async () => {
		const tree = makeTempTree();
		const good = tree.writeSession(ID_A, richSessionJsonl({ id: ID_A }));
		const malformed = tree.writeSession(ID_B, "this is not json\n");
		const empty = tree.writeSession(ID_C, sessionJsonl([], { id: ID_C }));
		const outcomes = await archiveInactiveSessions({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePaths: [good, malformed, empty],
			sessionDir: tree.sessionDir,
		});
		assert.deepEqual(
			outcomes.map((o) => o.result.status),
			["archived", "rejected", "rejected"],
		);
		assert.ok(!existsSync(good));
		// Rejected sources stay exactly where they were.
		assert.ok(existsSync(malformed));
		assert.ok(existsSync(empty));
	});

	it("refuses the current session inside the batch but archives the rest", async () => {
		const tree = makeTempTree();
		const [current, other] = [
			tree.writeSession(ID_A, richSessionJsonl({ id: ID_A })),
			tree.writeSession(ID_B, richSessionJsonl({ id: ID_B })),
		];
		const outcomes = await archiveInactiveSessions({
			deps: { dbPath: tree.dbPath, archiveRoot: tree.archiveRoot },
			sourcePaths: [current, other],
			currentSessionFile: current,
			sessionDir: tree.sessionDir,
		});
		assert.deepEqual(
			outcomes.map((o) => o.result.status),
			["rejected", "archived"],
		);
		assert.ok(existsSync(current));
		assert.ok(!existsSync(other));
	});

	it("keeps a failed move pending and still archives later sessions", async () => {
		const tree = makeTempTree();
		const [failing, fine] = [
			tree.writeSession(ID_A, richSessionJsonl({ id: ID_A })),
			tree.writeSession(ID_B, richSessionJsonl({ id: ID_B })),
		];
		let moved = 0;
		const outcomes = await archiveInactiveSessions({
			deps: {
				dbPath: tree.dbPath,
				archiveRoot: tree.archiveRoot,
				move: (source, dest, sha, size) => {
					moved += 1;
					if (moved === 1) throw new Error("disk full");
					mkdirSync(dirname(dest), { recursive: true });
					renameSync(source, dest);
					assert.equal(hashFile(dest).sha256, sha);
					assert.equal(hashFile(dest).size, size);
				},
			},
			sourcePaths: [failing, fine],
			sessionDir: tree.sessionDir,
		});
		assert.deepEqual(
			outcomes.map((o) => o.result.status),
			["failed", "archived"],
		);
		assert.ok(existsSync(failing));
		assert.ok(!existsSync(fine));
		const db = openArchiveDb(tree.dbPath);
		try {
			assert.equal(getSessionRow(db, ID_A)?.state, "pending");
			assert.equal(getSessionRow(db, ID_B)?.state, "archived");
		} finally {
			db.close();
		}
	});
});
