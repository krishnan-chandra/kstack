import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSubagentSessionStore } from "../shared/subagent-sessions.ts";
import { createSubagentHistory } from "./subagent-history.ts";
import {
	discoverSubagentHistory,
	readStableSubagentHistoryFile,
	readStableSubagentHistoryRanges,
	revalidateSubagentHistoryFile,
} from "./subagent-history-files.ts";
import {
	getIndexedSubagentSession,
	listIndexedSubagentSessions,
	openSubagentHistoryStore,
} from "./subagent-history-store.ts";
import { messageEntry, sessionJsonl, userMessage } from "./test-helpers.ts";

interface SyntheticSession {
	id: string;
	timestamp: string;
	text: string;
	name?: string;
	cwd?: string;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "kstack-subagent-history-"));
	const sourceRoot = join(root, "subagents");
	mkdirSync(join(sourceRoot, ".active"), { recursive: true });
	const dbPath = join(root, "agent", "cache", "kstack-subagent-history", "index.sqlite3");
	return { root, sourceRoot, dbPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function filename(session: SyntheticSession): string {
	return `${session.timestamp.replace(/[:.]/g, "-")}_${session.id}.jsonl`;
}

function content(session: SyntheticSession): string {
	const entries = [messageEntry("u1", null, userMessage(session.text))];
	if (session.name !== undefined) {
		entries.push({
			type: "session_info",
			id: "n1",
			parentId: "u1",
			timestamp: "2026-08-11T09:00:00.000Z",
			name: session.name,
		});
	}
	return sessionJsonl(entries, {
		id: session.id,
		timestamp: session.timestamp,
		cwd: session.cwd ?? "/tmp/synthetic-project",
	});
}

function writeSession(root: string, session: SyntheticSession): string {
	const path = join(root, filename(session));
	writeFileSync(path, content(session));
	return path;
}

const ONE = {
	id: "11111111-1111-4111-8111-111111111111",
	timestamp: "2026-08-11T08:48:02.226Z",
	text: "alpha retained needle",
	name: "old name",
};
const TWO = {
	id: "22222222-2222-4222-8222-222222222222",
	timestamp: "2026-08-12T08:48:02.226Z",
	text: "beta retained needle",
	name: "second child",
};
const THREE = {
	id: "33333333-3333-4333-8333-333333333333",
	timestamp: "2026-08-13T08:48:02.226Z",
	text: "gamma retained needle",
	name: "newest child",
};

describe("subagent history refresh and search", () => {
	it("searches phrase, prefix, cwd, role, UUID, latest name, and empty roots", async () => {
		const fx = fixture();
		try {
			writeSession(fx.sourceRoot, ONE);
			writeSession(fx.sourceRoot, TWO);
			const history = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath });
			assert.equal((await history.search({ query: '"alpha retained"' })).hits[0]?.sessionId, ONE.id);
			assert.equal((await history.search({ query: "bet*" })).hits[0]?.sessionId, TWO.id);
			assert.equal((await history.search({ query: "needle", cwd: "/tmp/synthetic-project" })).hits.length, 2);
			assert.equal((await history.search({ query: "needle", cwd: "/elsewhere" })).hits.length, 0);
			assert.ok((await history.search({ query: "needle", role: "user" })).hits.every((hit) => hit.role === "user"));
			const exact = await history.search({ query: "needle", sessionId: TWO.id });
			assert.deepEqual(
				exact.hits.map((hit) => hit.sessionId),
				[TWO.id],
			);
			assert.equal(exact.hits[0]?.sessionName, "second child");
			assert.equal(exact.coverage.complete, true);
			assert.equal((await history.search({ query: '"not-present"' })).hits.length, 0);
		} finally {
			fx.cleanup();
		}

		const empty = fixture();
		try {
			rmSync(empty.sourceRoot, { recursive: true, force: true });
			const result = await createSubagentHistory({ sourceRoot: empty.sourceRoot, dbPath: empty.dbPath }).search({
				query: "anything",
			});
			assert.equal(result.coverage.complete, true);
			assert.equal(result.hits.length, 0);
		} finally {
			empty.cleanup();
		}
	});

	it("does zero content rereads for stable signatures and reindexes only a changed file", async () => {
		const fx = fixture();
		let reads = 0;
		try {
			const onePath = writeSession(fx.sourceRoot, ONE);
			writeSession(fx.sourceRoot, TWO);
			const history = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				deps: {
					readStable: async (...args) => {
						reads++;
						return readStableSubagentHistoryFile(...args);
					},
				},
			});
			assert.equal((await history.search({ query: "needle" })).hits.length, 2);
			assert.equal(reads, 2);
			await history.search({ query: "needle" });
			assert.equal(reads, 2, "unchanged search must not reread JSONL content");

			writeFileSync(onePath, content({ ...ONE, text: "alpha replacement marker", name: "latest renamed child" }));
			const replacement = await history.search({ query: "replacement" });
			assert.equal(reads, 3, "only the changed source should be read");
			assert.equal(replacement.hits[0]?.sessionName, "latest renamed child");
			assert.equal((await history.search({ query: '"alpha retained"' })).hits.length, 0);
		} finally {
			fx.cleanup();
		}
	});

	it("indexes an uppercase header UUID once under its canonical filename ID", async () => {
		const fx = fixture();
		let reads = 0;
		try {
			const upper = { ...ONE, id: ONE.id.toUpperCase() };
			writeFileSync(join(fx.sourceRoot, filename(ONE)), content(upper));
			const history = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				deps: {
					readStable: async (...args) => {
						reads++;
						return readStableSubagentHistoryFile(...args);
					},
				},
			});
			const first = await history.search({ query: "alpha" });
			assert.equal(first.hits.length, 1);
			assert.equal(first.hits[0]?.sessionId, ONE.id);
			assert.deepEqual(first.coverage, {
				complete: true,
				indexedSessions: 1,
				pendingSessions: 0,
				activeSessions: 0,
				skippedSessions: 0,
				skipReasons: [],
			});
			const second = await history.search({ query: "alpha" });
			assert.equal(second.hits.length, 1);
			assert.equal(reads, 1, "a case-different header id must not force reindexing");
			assert.equal((await history.read({ sessionId: ONE.id })).kind, "page");
		} finally {
			fx.cleanup();
		}
	});

	it("fills the requested limit past invalidated ranked rows by paging the cache", async () => {
		const fx = fixture();
		try {
			// 120 entries in ONE outrank the single TWO entry; ONE then vanishes between refresh and validation.
			const many = Array.from({ length: 120 }, (_, index) =>
				messageEntry(`m${index}`, index === 0 ? null : `m${index - 1}`, userMessage(`needle needle ${index}`)),
			);
			const onePath = join(fx.sourceRoot, filename(ONE));
			writeFileSync(
				onePath,
				sessionJsonl(many, { id: ONE.id, timestamp: ONE.timestamp, cwd: "/tmp/synthetic-project" }),
			);
			writeSession(fx.sourceRoot, TWO);
			let revalidations = 0;
			const history = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				deps: {
					revalidate: async (file, options) => {
						revalidations++;
						if (file.sessionId === ONE.id) rmSync(onePath, { force: true });
						return revalidateSubagentHistoryFile(file, options);
					},
				},
			});
			const result = await history.search({ query: "needle", limit: 5 });
			assert.deepEqual(
				result.hits.map((hit) => hit.sessionId),
				[TWO.id],
			);
			assert.ok(revalidations >= 2);
			assert.equal(result.coverage.complete, false);
		} finally {
			fx.cleanup();
		}
	});

	it("classifies only the requested lease during an exact read", async () => {
		const fx = fixture();
		try {
			writeSession(fx.sourceRoot, ONE);
			writeSession(fx.sourceRoot, TWO);
			const leaseFor = (session: SyntheticSession) => join(fx.sourceRoot, ".active", `${session.id}.json`);
			writeFileSync(leaseFor(TWO), JSON.stringify({ state: "spawned", pid: process.pid, createdAt: TWO.timestamp }));
			const targeted = await discoverSubagentHistory({ root: fx.sourceRoot, leaseCheckSessionId: ONE.id });
			assert.deepEqual(targeted.activeSessionIds, []);
			assert.deepEqual(targeted.files.map((file) => file.sessionId).sort(), [ONE.id, TWO.id]);
			const full = await discoverSubagentHistory({ root: fx.sourceRoot });
			assert.deepEqual(full.activeSessionIds, [TWO.id]);

			const history = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath });
			assert.equal((await history.read({ sessionId: ONE.id })).kind, "page");
			assert.equal((await history.read({ sessionId: TWO.id })).kind, "active");
			assert.equal((await history.search({ query: "beta" })).hits.length, 0, "active sessions never surface");
		} finally {
			fx.cleanup();
		}
	});

	it("makes newest-first progress over a stable corpus larger than one refresh batch", async () => {
		const fx = fixture();
		const readOrder: string[] = [];
		try {
			for (const session of [ONE, TWO, THREE]) writeSession(fx.sourceRoot, session);
			const history = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				limits: { refreshSessions: 1 },
				deps: {
					readStable: async (file, options) => {
						readOrder.push(file.sessionId);
						return readStableSubagentHistoryFile(file, options);
					},
				},
			});
			const first = await history.search({ query: "needle" });
			assert.equal(first.coverage.pendingSessions, 2);
			assert.equal(first.hits.length, 1);
			const second = await history.search({ query: "needle" });
			assert.equal(second.coverage.pendingSessions, 1);
			assert.equal(second.hits.length, 2);
			const third = await history.search({ query: "needle" });
			assert.equal(third.coverage.complete, true);
			assert.equal(third.hits.length, 3);
			assert.deepEqual(readOrder, [THREE.id, TWO.id, ONE.id]);
		} finally {
			fx.cleanup();
		}
	});

	it("never returns stale text after deletion, replacement, activation, or hit-time invalidation", async () => {
		const fx = fixture();
		try {
			const path = writeSession(fx.sourceRoot, ONE);
			let history = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath });
			assert.equal((await history.search({ query: "alpha" })).hits.length, 1);
			rmSync(path);
			assert.equal((await history.search({ query: "alpha" })).hits.length, 0);
			assert.equal((await history.read({ sessionId: ONE.id })).kind, "unavailable");

			writeSession(fx.sourceRoot, { ...ONE, text: "replacement-only" });
			assert.equal((await history.search({ query: "alpha" })).hits.length, 0);
			assert.equal((await history.search({ query: "replacement" })).hits.length, 1);

			writeFileSync(
				join(fx.sourceRoot, ".active", `${ONE.id}.json`),
				JSON.stringify({ state: "spawned", pid: 999, createdAt: "2026-08-11T08:48:02.226Z" }),
			);
			history = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath, isPidAlive: () => true });
			assert.equal((await history.search({ query: "replacement" })).hits.length, 0);
			assert.equal((await history.read({ sessionId: ONE.id })).kind, "active");
		} finally {
			fx.cleanup();
		}

		const invalidated = fixture();
		try {
			writeSession(invalidated.sourceRoot, ONE);
			const history = createSubagentHistory({
				sourceRoot: invalidated.sourceRoot,
				dbPath: invalidated.dbPath,
				deps: {
					revalidate: async () => ({ kind: "changed", reason: "synthetic hit race" }),
				},
			});
			const result = await history.search({ query: "alpha" });
			assert.equal(result.hits.length, 0);
			assert.equal(result.coverage.complete, false);
		} finally {
			invalidated.cleanup();
		}
	});

	it("does not purge unseen cache rows after a partial enumeration", async () => {
		const fx = fixture();
		try {
			writeSession(fx.sourceRoot, ONE);
			await createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath }).search({ query: "alpha" });
			const partialHistory = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				deps: {
					discover: async () => ({
						root: fx.sourceRoot,
						complete: false,
						inspectedEntries: 1,
						files: [],
						activeSessionIds: [],
						skipped: [],
					}),
				},
			});
			const partial = await partialHistory.search({ query: "alpha" });
			assert.equal(partial.hits.length, 0, "unvalidated cached rows must not be returned");
			const db = openSubagentHistoryStore(fx.dbPath);
			assert.equal(getIndexedSubagentSession(db, ONE.id)?.sessionId, ONE.id);
			db.close();
		} finally {
			fx.cleanup();
		}
	});

	it("honors aborts, byte/session/time budgets, and concurrent calls", async () => {
		const fx = fixture();
		try {
			writeSession(fx.sourceRoot, ONE);
			writeSession(fx.sourceRoot, TWO);
			const abort = new AbortController();
			const aborting = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				deps: {
					readStable: async (...args) => {
						const result = await readStableSubagentHistoryFile(...args);
						abort.abort();
						return result;
					},
				},
			});
			await assert.rejects(() => aborting.search({ query: "needle" }, abort.signal), /abort/i);

			const deferred = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				limits: { refreshBytes: 1 },
			});
			const result = await deferred.search({ query: "needle" });
			assert.equal(result.coverage.pendingSessions, 2);
			assert.equal(result.coverage.skippedSessions, 0, "budget deferrals are not permanent skips");

			let clockReads = 0;
			const timeBounded = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: join(fx.root, "time-cache", "index.sqlite3"),
				limits: { refreshBudgetMs: 5_000 },
				deps: { now: () => (clockReads++ < 2 ? 0 : 6_000) },
			});
			const timed = await timeBounded.search({ query: "needle" });
			assert.equal(timed.coverage.indexedSessions, 1);
			assert.equal(timed.coverage.pendingSessions, 1);

			const oversized = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: join(fx.root, "size-cache", "index.sqlite3"),
				limits: { maxSessionBytes: 1 },
			});
			const skipped = await oversized.search({ query: "needle" });
			assert.equal(skipped.coverage.pendingSessions, 0);
			assert.equal(skipped.coverage.skippedSessions, 2);

			rmSync(fx.dbPath, { force: true });
			rmSync(`${fx.dbPath}-wal`, { force: true });
			rmSync(`${fx.dbPath}-shm`, { force: true });
			const concurrent = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath });
			const [left, right] = await Promise.all([
				concurrent.search({ query: "needle" }),
				concurrent.search({ query: "needle" }),
			]);
			assert.equal(left.hits.length, 2);
			assert.equal(right.hits.length, 2);
		} finally {
			fx.cleanup();
		}
	});
});

describe("exact retained subagent reads", () => {
	it("reads normalized and exact raw pages with UTF-8-safe chunk continuation", async () => {
		const fx = fixture();
		let fullReads = 0;
		let rangeReads = 0;
		try {
			const session = { ...ONE, text: `héllo ${"語".repeat(80)}` };
			const path = writeSession(fx.sourceRoot, session);
			const history = createSubagentHistory({
				sourceRoot: fx.sourceRoot,
				dbPath: fx.dbPath,
				limits: { readBodyBytes: 80 },
				deps: {
					readStable: async (...args) => {
						fullReads++;
						return readStableSubagentHistoryFile(...args);
					},
					readRanges: async (...args) => {
						rangeReads++;
						return readStableSubagentHistoryRanges(...args);
					},
				},
			});
			const normalized = await history.read({ sessionId: ONE.id, limit: 2 });
			assert.equal(normalized.kind, "page");
			if (normalized.kind === "page") {
				assert.equal(normalized.firstOrdinal, 0);
				assert.ok(Buffer.byteLength(normalized.body) <= 80);
				assert.ok(!normalized.body.includes("�"));
			}

			let chunk = 0;
			let raw = "";
			while (true) {
				const page = await history.read({ sessionId: ONE.id, offset: 0, limit: 2, format: "raw", chunk });
				assert.equal(page.kind, "page");
				if (page.kind !== "page") break;
				raw += page.body;
				if (page.next?.offset !== 0) break;
				chunk = page.next.chunk;
			}
			const expected = readFileSync(path, "utf8").trim().split("\n").slice(1, 3).join("\n");
			assert.equal(raw, expected);
			assert.ok(!raw.includes("�"));
			assert.equal(fullReads, 1, "raw continuation should use cached exact ranges instead of full source rereads");
			assert.ok(rangeReads > 0);

			const beyond = await history.read({ sessionId: ONE.id, offset: 1000 });
			assert.equal(beyond.kind, "page");
			if (beyond.kind === "page") assert.equal(beyond.pageEntries, 0);
			const invalidChunk = await history.read({ sessionId: ONE.id, chunk: 999 });
			assert.equal(invalidChunk.kind, "invalid");
		} finally {
			fx.cleanup();
		}
	});

	it("refreshes only the requested UUID and reconstructs a deleted cache on restart", async () => {
		const fx = fixture();
		try {
			writeSession(fx.sourceRoot, ONE);
			writeSession(fx.sourceRoot, TWO);
			let history = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath });
			assert.equal((await history.read({ sessionId: ONE.id })).kind, "page");
			let db = openSubagentHistoryStore(fx.dbPath);
			assert.deepEqual(
				listIndexedSubagentSessions(db).map((row) => row.sessionId),
				[ONE.id],
			);
			db.close();

			rmSync(fx.dbPath, { force: true });
			rmSync(`${fx.dbPath}-wal`, { force: true });
			rmSync(`${fx.dbPath}-shm`, { force: true });
			history = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath });
			assert.equal((await history.read({ sessionId: ONE.id, format: "raw" })).kind, "page");
			db = openSubagentHistoryStore(fx.dbPath);
			assert.deepEqual(
				listIndexedSubagentSessions(db).map((row) => row.sessionId),
				[ONE.id],
			);
			db.close();
		} finally {
			fx.cleanup();
		}
	});

	it("tracks retention pruning end to end without inferring success from inactivity", async () => {
		const fx = fixture();
		try {
			const onePath = writeSession(fx.sourceRoot, ONE);
			writeSession(fx.sourceRoot, TWO);
			writeFileSync(
				join(fx.sourceRoot, ".active", `${TWO.id}.json`),
				JSON.stringify({ state: "spawned", pid: 999, createdAt: TWO.timestamp }),
			);
			const history = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath, isPidAlive: () => true });
			assert.equal((await history.search({ query: "alpha" })).hits.length, 1);
			assert.equal((await history.search({ query: "beta" })).hits.length, 0);

			const triggerId = "44444444-4444-4444-8444-444444444444";
			const store = createSubagentSessionStore({
				root: fx.sourceRoot,
				cap: 1,
				uuid: () => triggerId,
				pid: 123,
				isPidAlive: () => true,
			});
			const prepared = store.prepare({ owner: "test", label: "retention" }, "/tmp/synthetic-project");
			assert.equal(prepared.ok, true);
			if (prepared.ok) store.finish(prepared.prepared, { spawnFailed: true });
			assert.equal(existsSync(onePath), false);
			const restarted = createSubagentHistory({ sourceRoot: fx.sourceRoot, dbPath: fx.dbPath, isPidAlive: () => true });
			assert.equal((await restarted.search({ query: "alpha" })).hits.length, 0);
			assert.equal((await restarted.read({ sessionId: ONE.id })).kind, "unavailable");
		} finally {
			fx.cleanup();
		}
	});
});
