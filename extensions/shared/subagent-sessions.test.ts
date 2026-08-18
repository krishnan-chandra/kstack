import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createSubagentSessionStore, validateSessionHeader } from "./subagent-sessions.ts";

const ID = "00000000-0000-4000-8000-000000000001";

function fixture(options: { cap?: number; isPidAlive?: (pid: number) => boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "kstack-subagent-sessions-"));
	const root = join(dir, "subagents");
	const store = createSubagentSessionStore({
		root,
		uuid: () => ID,
		pid: 123,
		cap: options.cap,
		isPidAlive: options.isPidAlive,
	});
	return { dir, root, store };
}

function prepare(store: ReturnType<typeof createSubagentSessionStore>) {
	const result = store.prepare({ owner: "panel-review", label: "lead" }, "/repo");
	if (!result.ok) throw new Error("session preparation failed");
	return result.prepared;
}

describe("subagent session store", () => {
	it("creates safe flat directories, lease, and exact CLI args", () => {
		const fx = fixture();
		try {
			const prepared = prepare(fx.store);
			assert.equal(lstatSync(fx.root).isDirectory(), true);
			assert.equal(lstatSync(join(fx.root, ".active")).isDirectory(), true);
			assert.equal(existsSync(prepared.leaseFile), true);
			assert.deepEqual(prepared.cliArgs, ["--session-id", ID, "--session-dir", fx.root, "--name", "panel-review/lead"]);
			assert.equal(prepared.expectedCwd, "/repo");
		} finally {
			rmSync(fx.dir, { recursive: true, force: true });
		}
	});

	it("rejects unsafe identities before creating the root", () => {
		const fx = fixture();
		try {
			const result = fx.store.prepare({ owner: "../escape", label: "lead" }, "/repo");
			assert.equal(result.ok, false);
			if (!result.ok) assert.deepEqual(result.failure.session, { kind: "missing", reason: "setup-failed" });
			assert.equal(existsSync(fx.root), false);
		} finally {
			rmSync(fx.dir, { recursive: true, force: true });
		}
	});

	it("validates the authoritative header and resolves its native file", () => {
		const fx = fixture();
		try {
			const prepared = prepare(fx.store);
			const raw = { type: "session", version: 3, id: ID, timestamp: "2026-01-02T03:04:05.006Z", cwd: "/repo" };
			const validated = validateSessionHeader(raw, prepared);
			assert.equal(validated.ok, true);
			if (!validated.ok) return;
			const file = join(fx.root, `2026-01-02T03-04-05-006Z_${ID}.jsonl`);
			writeFileSync(file, `${JSON.stringify(raw)}\n`);
			assert.deepEqual(fx.store.finish(prepared, { header: validated.header, spawnFailed: false }), {
				kind: "persisted",
				id: ID,
				name: "panel-review/lead",
				file,
			});
			assert.equal(existsSync(prepared.leaseFile), false);
		} finally {
			rmSync(fx.dir, { recursive: true, force: true });
		}
	});

	it("returns protocol and file missing outcomes truthfully", () => {
		const fx = fixture();
		try {
			const prepared = prepare(fx.store);
			assert.equal(
				validateSessionHeader({ type: "session", version: 3, id: "wrong", timestamp: "bad", cwd: "/repo" }, prepared)
					.ok,
				false,
			);
			assert.deepEqual(fx.store.finish(prepared, { spawnFailed: false, forcedMissingReason: "protocol-mismatch" }), {
				kind: "missing",
				id: ID,
				name: "panel-review/lead",
				reason: "protocol-mismatch",
			});
		} finally {
			rmSync(fx.dir, { recursive: true, force: true });
		}
	});

	it("prunes the oldest completed file while preserving an active one", () => {
		const fx = fixture({ cap: 1, isPidAlive: () => true });
		try {
			const prepared = prepare(fx.store);
			const activeId = "00000000-0000-4000-8000-000000000002";
			const active = join(fx.root, `2020-01-01T00-00-00-000Z_${activeId}.jsonl`);
			const completed = join(fx.root, `2021-01-01T00-00-00-000Z_${ID}.jsonl`);
			writeFileSync(active, `${JSON.stringify({ type: "session", timestamp: "2020-01-01T00:00:00.000Z" })}\n`);
			writeFileSync(completed, `${JSON.stringify({ type: "session", timestamp: "2021-01-01T00:00:00.000Z" })}\n`);
			writeFileSync(
				join(fx.root, ".active", `${activeId}.json`),
				JSON.stringify({ state: "spawned", pid: 999, createdAt: "2026-01-01T00:00:00.000Z" }),
			);
			fx.store.finish(prepared, { spawnFailed: false });
			assert.equal(existsSync(active), true);
			assert.equal(existsSync(completed), false);
			assert.deepEqual(
				readdirSync(fx.root).filter((name) => name.endsWith(".jsonl")),
				[active.split("/").pop()],
			);
		} finally {
			rmSync(fx.dir, { recursive: true, force: true });
		}
	});
});
