import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createFloorLedger, defaultLedgerRoot, hashGenerationId, ledgerDirectoryFor } from "./floor-ledger.ts";

const now = new Date("2026-09-07T12:00:00.000Z");
const scopes: string[] = [];

type TestLedgerOptions = NonNullable<Parameters<typeof createFloorLedger>[0]>;
interface WorkingDirectoryScope {
	key: string;
	label: "working directory";
}

afterEach(async () => {
	await Promise.all(scopes.splice(0).map((scope) => rm(scope, { recursive: true, force: true })));
});

async function tempScope(): Promise<string> {
	const scope = await mkdtemp(join(tmpdir(), "openrouter-floor-ledger-"));
	scopes.push(scope);
	return scope;
}

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "openrouter-floor-root-"));
	scopes.push(root);
	return root;
}

function workingDirectoryKey(cwd: string): string {
	return createHash("sha256")
		.update(realpathSync(resolve(cwd)))
		.digest("hex");
}

async function resolveWorkingDirectoryScope(cwd: string): Promise<WorkingDirectoryScope> {
	return { key: workingDirectoryKey(cwd), label: "working directory" };
}

function createTestLedger(rootDirectory: string, options: TestLedgerOptions = {}) {
	return createFloorLedger({ ...options, rootDirectory, resolveScope: resolveWorkingDirectoryScope });
}

describe("floor ledger", () => {
	it("derives the default ledger root from the Pi agent directory", () => {
		assert.equal(defaultLedgerRoot({ PI_CODING_AGENT_DIR: "/tmp/agent-x" }), "/tmp/agent-x/openrouter-floor/ledger-v1");
	});

	it("never writes under the scope cwd", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		const ledger = createTestLedger(root, { processId: "p-scope", now: () => now });

		await ledger.append(scope, { kind: "rewrite", eventId: "p-scope:e1", at: now.toISOString() });
		await ledger.flush();

		assert.equal(existsSync(join(scope, ".pi")), false);
		assert.deepEqual(await readdir(ledgerDirectoryFor(root, workingDirectoryKey(scope))), ["p-scope.2026-09-07.jsonl"]);
	});

	it("serializes redacted events into a per-process shard and reads valid records", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		const ledger = createTestLedger(root, { processId: "p-one", now: () => now });
		await ledger.append(scope, { kind: "rewrite", eventId: "p-one:e1", at: now.toISOString() });
		await ledger.append(scope, {
			kind: "generation",
			eventId: "p-one:e2",
			at: now.toISOString(),
			generationKeyHash: hashGenerationId("gen-secret-id"),
			state: "observed",
			tier: "unknown",
			reason: "pending",
		});
		await ledger.flush();

		const path = join(ledgerDirectoryFor(root, workingDirectoryKey(scope)), "p-one.2026-09-07.jsonl");
		const content = await readFile(path, "utf8");
		assert.doesNotMatch(content, /gen-secret-id/);
		assert.doesNotMatch(content, /Authorization|prompt|response text/i);
		const { events } = await ledger.read(scope);
		assert.equal(events.length, 2);
		assert.equal(events[0]?.kind, "rewrite");
		assert.equal(events[1]?.kind, "generation");
	});

	it("ignores malformed lines and timestamps outside retention", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		const ledger = createTestLedger(root, { processId: "p-two", now: () => now });
		await ledger.append(scope, {
			kind: "rewrite",
			eventId: "p-two:old",
			at: "2026-07-01T00:00:00.000Z",
		});
		await ledger.append(scope, {
			kind: "rewrite",
			eventId: "p-two:new",
			at: now.toISOString(),
		});
		await ledger.flush();
		await appendFile(
			join(ledgerDirectoryFor(root, workingDirectoryKey(scope)), "p-two.jsonl"),
			'{"version":1,"kind":"rewrite"}\n',
			"utf8",
		);

		const { events } = await ledger.read(scope);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.eventId, "p-two:new");
	});

	it("stops appending at the configured shard line limit", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		const ledger = createTestLedger(root, {
			processId: "p-three",
			now: () => now,
			maxLinesPerShard: 1,
		});
		await ledger.append(scope, { kind: "rewrite", eventId: "p-three:e1", at: now.toISOString() });
		await ledger.append(scope, { kind: "rewrite", eventId: "p-three:e2", at: now.toISOString() });
		const { events } = await ledger.read(scope);
		assert.equal(events.length, 1);
		assert.ok(events[0]);
		assert.equal(events[0].eventId, "p-three:e1");
	});

	it("rotates daily so expired events cannot block current telemetry", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		let clock = new Date("2026-08-01T12:00:00.000Z");
		const ledger = createTestLedger(root, {
			processId: "p-rotate",
			now: () => clock,
			maxLinesPerShard: 1,
		});
		await ledger.append(scope, { kind: "rewrite", eventId: "p-rotate:old", at: clock.toISOString() });

		clock = new Date("2026-09-07T12:00:00.000Z");
		await ledger.append(scope, { kind: "rewrite", eventId: "p-rotate:new", at: clock.toISOString() });

		const { events } = await ledger.read(scope);
		assert.deepEqual(
			events.map((event) => event.eventId),
			["p-rotate:new"],
		);
		assert.deepEqual(await readdir(ledgerDirectoryFor(root, workingDirectoryKey(scope))), [
			"p-rotate.2026-09-07.jsonl",
		]);
	});

	it("reads and accounts for more than 256 retained shards", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		for (let index = 0; index < 257; index += 1) {
			const processId = `p-many-${index}`;
			const ledger = createTestLedger(root, { processId, now: () => now });
			await ledger.append(scope, { kind: "rewrite", eventId: `${processId}:event`, at: now.toISOString() });
		}

		const ledger = createTestLedger(root, { processId: "p-reader", now: () => now });
		assert.equal((await ledger.read(scope)).events.length, 257);
	});

	it("stops appending when the scope byte budget is exhausted", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		const ledger = createTestLedger(root, {
			processId: "p-four",
			now: () => now,
			maxTotalBytes: 1,
		});
		await ledger.append(scope, { kind: "rewrite", eventId: "p-four:e1", at: now.toISOString() });
		assert.deepEqual((await ledger.read(scope)).events, []);
	});

	it("resolves the scope once per cwd", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		let resolutions = 0;
		const repositoryKey = "b".repeat(64);
		const ledger = createFloorLedger({
			rootDirectory: root,
			processId: "p-cache",
			now: () => now,
			resolveScope: async () => {
				resolutions += 1;
				return { key: repositoryKey, label: "repository" };
			},
		});

		await ledger.append(scope, { kind: "rewrite", eventId: "p-cache:e1", at: now.toISOString() });
		await ledger.append(scope, { kind: "rewrite", eventId: "p-cache:e2", at: now.toISOString() });
		const readResult = await ledger.read(scope);

		assert.equal(readResult.events.length, 2);
		assert.equal(readResult.scopeLabel, "repository");
		assert.equal(resolutions, 1);
	});

	it("falls back to the working-directory key when resolution fails", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		const ledger = createFloorLedger({
			rootDirectory: root,
			processId: "p-fallback",
			now: () => now,
			resolveScope: async () => {
				throw new Error("not a repository");
			},
		});

		await ledger.append(scope, { kind: "rewrite", eventId: "p-fallback:e1", at: now.toISOString() });
		const readResult = await ledger.read(scope);

		assert.equal(readResult.scopeLabel, "working directory");
		assert.deepEqual(await readdir(ledgerDirectoryFor(root, workingDirectoryKey(scope))), [
			"p-fallback.2026-09-07.jsonl",
		]);
	});

	it("leaves the old scope untouched and restarts reporting under the repository key", async () => {
		const scope = await tempScope();
		const root = await tempRoot();
		const oldLedger = createTestLedger(root, { processId: "p-old", now: () => now });
		await oldLedger.append(scope, { kind: "rewrite", eventId: "p-old:e1", at: now.toISOString() });
		const oldDirectory = ledgerDirectoryFor(root, workingDirectoryKey(scope));
		const oldShards = await readdir(oldDirectory);

		const repositoryKey = "c".repeat(64);
		const repositoryLedger = createFloorLedger({
			rootDirectory: root,
			processId: "p-repository",
			now: () => now,
			resolveScope: async () => ({ key: repositoryKey, label: "repository" }),
		});
		await repositoryLedger.append(scope, {
			kind: "rewrite",
			eventId: "p-repository:e1",
			at: now.toISOString(),
		});
		const readResult = await repositoryLedger.read(scope);

		assert.deepEqual(await readdir(oldDirectory), oldShards);
		assert.deepEqual(
			readResult.events.map((event) => event.eventId),
			["p-repository:e1"],
		);
		assert.equal(readResult.scopeLabel, "repository");
		assert.deepEqual(await readdir(ledgerDirectoryFor(root, repositoryKey)), ["p-repository.2026-09-07.jsonl"]);
	});
});
