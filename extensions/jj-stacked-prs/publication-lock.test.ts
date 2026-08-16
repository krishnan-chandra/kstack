import assert from "node:assert/strict";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquirePublicationLock } from "./publication-lock.ts";

function lockFile(locksDir: string): string {
	const name = readdirSync(locksDir).find((entry) => entry.startsWith("publish-") && entry.endsWith(".json"));
	assert.ok(name);
	return join(locksDir, name);
}

describe("publication lock", () => {
	const dirs: string[] = [];
	function tempLocksDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pub-lock-test-"));
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("publishes a complete owner payload atomically and removes it on release", () => {
		const locksDir = tempLocksDir();
		const result = acquirePublicationLock({
			repositoryPath: "/repo/example",
			locksDir,
			pid: 12345,
			now: () => new Date("2025-01-01T00:00:00Z"),
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;

		const content: unknown = JSON.parse(readFileSync(lockFile(locksDir), "utf8"));
		assert.ok(typeof content === "object" && content !== null);
		assert.deepEqual(Object.fromEntries(Object.entries(content).filter(([key]) => key !== "ownerToken")), {
			pid: 12345,
			startedAt: "2025-01-01T00:00:00.000Z",
			repositoryPath: "/repo/example",
		});
		assert.ok("ownerToken" in content && typeof content.ownerToken === "string" && content.ownerToken.length > 0);
		assert.deepEqual(
			readdirSync(locksDir).filter((entry) => entry.includes("candidate")),
			[],
		);

		result.lock.release();
		assert.deepEqual(readdirSync(locksDir), []);
	});

	it("blocks a second acquire while the holder is alive", () => {
		const locksDir = tempLocksDir();
		const first = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 100,
			isPidAlive: () => true,
			now: () => new Date("2025-06-01T00:00:00Z"),
		});
		assert.equal(first.ok, true);

		const second = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 200,
			isPidAlive: () => true,
			now: () => new Date("2025-06-01T00:00:01Z"),
		});
		assert.deepEqual(second, {
			ok: false,
			holder: { pid: 100, startedAt: "2025-06-01T00:00:00.000Z" },
		});
		if (first.ok) first.lock.release();
	});

	it("reclaims a lock whose holder is dead", () => {
		const locksDir = tempLocksDir();
		const first = acquirePublicationLock({ repositoryPath: "/repo", locksDir, pid: 100 });
		assert.equal(first.ok, true);

		const second = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 200,
			isPidAlive: () => false,
		});
		assert.equal(second.ok, true);
		if (second.ok) second.lock.release();
	});

	it("does not steal an old lock while its holder is alive", () => {
		const locksDir = tempLocksDir();
		const first = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 100,
			isPidAlive: () => true,
			now: () => new Date("2025-06-01T00:00:00Z"),
		});
		assert.equal(first.ok, true);

		const second = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 200,
			isPidAlive: () => true,
			now: () => new Date("2025-06-01T02:00:00Z"),
			staleAfterMs: 60 * 60 * 1000,
		});
		assert.equal(second.ok, false);
		if (first.ok) first.lock.release();
	});

	it("blocks on a fresh corrupt lock and reclaims it only after the grace period", () => {
		const locksDir = tempLocksDir();
		const first = acquirePublicationLock({ repositoryPath: "/repo", locksDir, pid: 100 });
		assert.equal(first.ok, true);
		const path = lockFile(locksDir);
		writeFileSync(path, "not-json{{{");
		utimesSync(path, new Date("2025-06-01T00:00:00Z"), new Date("2025-06-01T00:00:00Z"));

		const fresh = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 200,
			now: () => new Date("2025-06-01T00:30:00Z"),
			staleAfterMs: 60 * 60 * 1000,
		});
		assert.equal(fresh.ok, false);

		const stale = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 300,
			now: () => new Date("2025-06-01T02:00:00Z"),
			staleAfterMs: 60 * 60 * 1000,
		});
		assert.equal(stale.ok, true);
		if (stale.ok) stale.lock.release();
	});

	it("refuses a symlink lock without touching its target", () => {
		const locksDir = tempLocksDir();
		const probe = acquirePublicationLock({ repositoryPath: "/repo", locksDir, pid: 100 });
		assert.equal(probe.ok, true);
		const path = lockFile(locksDir);
		if (probe.ok) probe.lock.release();

		const targetDir = tempLocksDir();
		const targetFile = join(targetDir, "target.json");
		writeFileSync(targetFile, "target");
		symlinkSync(targetFile, path);

		const result = acquirePublicationLock({ repositoryPath: "/repo", locksDir, pid: 200 });
		assert.deepEqual(result, { ok: false, holder: undefined });
		assert.ok(lstatSync(targetFile).isFile());
		assert.equal(readFileSync(targetFile, "utf8"), "target");
	});

	it("an old owner cannot release a replacement lock", () => {
		const locksDir = tempLocksDir();
		const first = acquirePublicationLock({ repositoryPath: "/repo", locksDir, pid: 100 });
		assert.equal(first.ok, true);
		if (!first.ok) return;
		unlinkSync(lockFile(locksDir));

		const second = acquirePublicationLock({ repositoryPath: "/repo", locksDir, pid: 200 });
		assert.equal(second.ok, true);
		if (!second.ok) return;
		first.lock.release();

		const contender = acquirePublicationLock({
			repositoryPath: "/repo",
			locksDir,
			pid: 300,
			isPidAlive: () => true,
		});
		assert.equal(contender.ok, false);
		second.lock.release();
	});

	it("makes release idempotent", () => {
		const locksDir = tempLocksDir();
		const result = acquirePublicationLock({ repositoryPath: "/repo", locksDir, pid: 100 });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		result.lock.release();
		result.lock.release();
	});

	it("creates the lock directory recursively", () => {
		const base = tempLocksDir();
		const nested = join(base, "deep", "nested", "locks");
		const result = acquirePublicationLock({ repositoryPath: "/repo", locksDir: nested, pid: 100 });
		assert.equal(result.ok, true);
		if (result.ok) result.lock.release();
	});

	it("uses independent lock files for different canonical repository paths", () => {
		const locksDir = tempLocksDir();
		const first = acquirePublicationLock({ repositoryPath: "/repo/a", locksDir, pid: 100 });
		const second = acquirePublicationLock({ repositoryPath: "/repo/b", locksDir, pid: 200 });
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		if (first.ok) first.lock.release();
		if (second.ok) second.lock.release();
	});
});
