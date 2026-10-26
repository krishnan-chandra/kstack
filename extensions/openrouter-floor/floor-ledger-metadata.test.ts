import assert from "node:assert/strict";
import { basename } from "node:path";
import { describe, it } from "node:test";
import { createFloorLedger } from "./floor-ledger.ts";

type LedgerOptions = NonNullable<Parameters<typeof createFloorLedger>[0]>;
type LedgerFileSystem = NonNullable<LedgerOptions["fileSystem"]>;
interface FileSystemCalls {
	readdir: number;
	stat: string[];
	readFile: string[];
	unlink: string[];
	append: string[];
}
const clock = new Date("2026-09-07T12:00:00.000Z");
const scopeKey = "a".repeat(64);
const dated = "p.2026-09-07.jsonl";

function fsError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

function eventLine(eventId: string): string {
	return `${JSON.stringify({ version: 1, kind: "rewrite", eventId, processId: "p", scopeKey, at: clock.toISOString() })}\n`;
}

function fixture(options: LedgerOptions = {}) {
	const files = new Map<string, { content: string; mtimeMs: number }>();
	const calls: FileSystemCalls = {
		readdir: 0,
		stat: [],
		readFile: [],
		unlink: [],
		append: [],
	};
	const diagnostics: string[] = [];
	const statErrors = new Map<string, string>();
	const unlinkErrors = new Map<string, string>();
	const readErrors = new Map<string, string>();
	let beforeListing = (_listing: number) => {};
	function put(name: string, content = eventLine(name.replaceAll(".", "-")), mtimeMs = clock.getTime()) {
		files.set(name, { content, mtimeMs });
	}
	function get(name: string) {
		const file = files.get(name);
		if (!file) throw fsError("ENOENT");
		return file;
	}
	const fileSystem: LedgerFileSystem = {
		async mkdir() {},
		async readdir() {
			calls.readdir += 1;
			beforeListing(calls.readdir);
			return [...files.keys()];
		},
		async stat(path) {
			const name = basename(path);
			calls.stat.push(name);
			const error = statErrors.get(name);
			if (error) throw fsError(error);
			const file = get(name);
			return { size: Buffer.byteLength(file.content), mtimeMs: file.mtimeMs };
		},
		async readFile(path) {
			const name = basename(path);
			calls.readFile.push(name);
			const error = readErrors.get(name);
			if (error) throw fsError(error);
			return get(name).content;
		},
		async appendFile(path, content) {
			const name = basename(path);
			calls.append.push(content);
			put(name, (files.get(name)?.content ?? "") + content);
		},
		async unlink(path) {
			const name = basename(path);
			calls.unlink.push(name);
			const error = unlinkErrors.get(name);
			if (error) throw fsError(error);
			if (!files.delete(name)) throw fsError("ENOENT");
		},
	};
	const ledger = createFloorLedger({
		rootDirectory: "/unused-ledger-fixture",
		processId: "writer",
		now: () => clock,
		resolveScope: async () => ({ key: scopeKey, label: "repository" }),
		fileSystem,
		onDiagnostic: (message) => diagnostics.push(message),
		...options,
	});
	return {
		ledger,
		calls,
		diagnostics,
		statErrors,
		unlinkErrors,
		readErrors,
		put,
		onListing(hook: (listing: number) => void) {
			beforeListing = hook;
		},
		append: () => ledger.append("scope", { kind: "rewrite", eventId: "new", at: clock.toISOString() }),
	};
}

describe("floor ledger retained-shard metadata work", () => {
	for (const n of [1, 100, 1000]) {
		for (const operation of ["append", "read"] as const) {
			it(`${operation} stats ${n} retained dated shards once`, async () => {
				const f = fixture();
				for (let i = 0; i < n; i += 1) f.put(`p${i}.2026-09-07.jsonl`);
				if (operation === "append") {
					await f.append();
					await f.ledger.flush();
					assert.equal(f.calls.append.length, 1);
				} else {
					assert.equal((await f.ledger.read("scope")).events.length, n);
				}
				assert.equal(f.calls.stat.length, n);
				assert.equal(new Set(f.calls.stat).size, n);
				assert.equal(f.calls.readdir, operation === "append" ? 2 : 1);
			});
		}
	}
	for (const operation of ["append", "read"] as const) {
		it(`${operation} keeps two stats for each retained legacy shard`, async () => {
			const f = fixture();
			for (let i = 0; i < 3; i += 1) f.put(`p${i}.2026-09-07.jsonl`);
			for (let i = 0; i < 2; i += 1) f.put(`legacy${i}.jsonl`);
			if (operation === "append") await f.append();
			else assert.equal((await f.ledger.read("scope")).events.length, 5);
			assert.equal(f.calls.stat.length, 3 + 2 * 2);
		});
	}
});

describe("floor ledger accounting characterization", () => {
	it("retains cutoff-day, future and malformed calendar dates; prunes expired dated and legacy shards", async () => {
		const f = fixture();
		for (const name of [
			dated,
			"boundary.2026-08-08.jsonl",
			"future.2099-01-01.jsonl",
			"nan.2026-13-01.jsonl",
			"roll.2026-02-30.jsonl",
			"expired.2026-08-07.jsonl",
			"legacy.jsonl",
			"old.jsonl",
			"invalid.date.jsonl",
			"bad!.jsonl",
			"ignored.txt",
		])
			f.put(name);
		f.put("old.jsonl", eventLine("old"), 0);
		const report = await f.ledger.read("scope");
		assert.equal(report.scopeLabel, "repository");
		assert.deepEqual(
			report.events.map((e) => e.eventId),
			[
				"boundary-2026-08-08-jsonl",
				"future-2099-01-01-jsonl",
				"legacy-jsonl",
				"nan-2026-13-01-jsonl",
				"p-2026-09-07-jsonl",
			],
		);
		assert.deepEqual(f.calls.unlink, ["roll.2026-02-30.jsonl", "expired.2026-08-07.jsonl", "old.jsonl"]);
		assert.ok(!f.calls.stat.includes("invalid.date.jsonl"));
		assert.ok(!f.calls.stat.includes("bad!.jsonl"));
		assert.ok(!f.calls.stat.includes("ignored.txt"));
		assert.deepEqual(f.diagnostics, Array(3).fill("ledger shard pruned: retention"));
	});
	it("preserves stat/unlink failure policy for expired and legacy shards", async () => {
		const f = fixture();
		f.put("expired.2026-01-01.jsonl");
		f.put("legacy.jsonl", eventLine("legacy"), 0);
		f.put("denied.jsonl");
		f.unlinkErrors.set("expired.2026-01-01.jsonl", "EACCES");
		f.unlinkErrors.set("legacy.jsonl", "EACCES");
		f.statErrors.set("denied.jsonl", "EIO");
		assert.deepEqual(
			(await f.ledger.read("scope")).events.map((e) => e.eventId),
			["expired-2026-01-01-jsonl", "legacy"],
		);
		assert.equal(f.diagnostics.filter((d) => d === "ledger shard prune failed").length, 3);
		assert.ok(f.diagnostics.includes("ledger read skipped: shard stat failed"));
	});
	for (const mutation of ["create", "grow"] as const) {
		it(`fresh append accounting sees a concurrent ${mutation} and rejects over budget`, async () => {
			const f = fixture({ maxTotalBytes: 1000 });
			f.put(dated);
			f.onListing((listing) => {
				if (listing === 2) f.put(mutation === "create" ? "other.2026-09-07.jsonl" : dated, "x".repeat(1001));
			});
			await f.append();
			assert.equal(f.calls.readdir, 2);
			assert.equal(f.calls.append.length, 0);
			assert.ok(f.calls.stat.includes(mutation === "create" ? "other.2026-09-07.jsonl" : dated));
			assert.deepEqual(f.diagnostics, ["ledger append dropped: scope byte limit"]);
			assert.deepEqual(
				(await f.ledger.read("scope")).events.map((e) => e.eventId),
				mutation === "create" ? ["p-2026-09-07-jsonl"] : [],
			);
			assert.ok(f.diagnostics.includes("ledger read skipped: shard budget exceeded"));
		});
	}
	for (const code of ["ENOENT", "EACCES"]) {
		it(`final dated stat ${code} keeps conservative append/report behavior`, async () => {
			const f = fixture();
			f.put(dated);
			f.statErrors.set(dated, code);
			if (code === "ENOENT") {
				await f.append();
				assert.equal(f.calls.append.length, 1);
			} else {
				await assert.rejects(f.append(), { message: code });
				assert.equal(f.calls.append.length, 0);
			}
			await f.ledger.flush();
			assert.deepEqual(
				(await f.ledger.read("scope")).events.map((e) => e.eventId),
				code === "ENOENT" ? ["new"] : [],
			);
			assert.equal(f.diagnostics.includes("ledger read skipped: shard stat failed"), code !== "ENOENT");
		});
		it(`report readFile ${code} skips without consuming a later shard's event`, async () => {
			const f = fixture();
			f.put(dated);
			f.put("z.2026-09-07.jsonl");
			f.readErrors.set(dated, code);
			assert.deepEqual(
				(await f.ledger.read("scope")).events.map((e) => e.eventId),
				["z-2026-09-07-jsonl"],
			);
			assert.equal(f.diagnostics.includes("ledger read skipped: shard unavailable"), code !== "ENOENT");
		});
	}
	for (const failure of ["stat", "unlink"] as const) {
		it(`tolerates vanished expired and legacy shards during ${failure}`, async () => {
			const f = fixture();
			const names = ["expired.2026-01-01.jsonl", "legacy.jsonl"];
			for (const name of names) {
				f.put(name, eventLine("retained"), 0);
				if (failure === "stat") f.statErrors.set(name, "ENOENT");
				else {
					f.unlinkErrors.set(name, "ENOENT");
					f.readErrors.set(name, "ENOENT");
				}
			}
			assert.deepEqual((await f.ledger.read("scope")).events, []);
			assert.deepEqual(f.diagnostics, []);
			assert.equal(f.calls.stat.length, 4);
			assert.deepEqual(f.calls.unlink, failure === "unlink" ? names : []);
		});
	}
	it("preserves exact serialized event bytes and the scope byte-limit boundary", async () => {
		const line = `${JSON.stringify({ version: 1, kind: "rewrite", eventId: "new", processId: "writer", scopeKey, at: clock.toISOString() })}\n`;
		const f = fixture({ maxTotalBytes: Buffer.byteLength(line) });
		await f.append();
		assert.deepEqual(f.calls.append, [line]);
		await f.append();
		assert.deepEqual(f.calls.append, [line]);
		assert.deepEqual(f.diagnostics, ["ledger append dropped: scope byte limit"]);
	});
	it("does not refund report byte accounting after readFile fails", async () => {
		const f = fixture({ maxTotalBytes: Buffer.byteLength(eventLine("first")) });
		f.put(dated, eventLine("first"));
		f.put("z.2026-09-07.jsonl", eventLine("later"));
		f.readErrors.set(dated, "EIO");
		assert.deepEqual((await f.ledger.read("scope")).events, []);
		assert.deepEqual(f.calls.readFile, [dated]);
		assert.deepEqual(
			f.diagnostics.filter((d) => !d.includes("prune")),
			["ledger read skipped: shard unavailable", "ledger read skipped: shard budget exceeded"],
		);
	});
});
