import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createFloorLedger, hashGenerationId, ledgerDirectoryFor } from "./floor-ledger.ts";

const now = new Date("2026-09-07T12:00:00.000Z");
const scopes: string[] = [];

afterEach(async () => {
	await Promise.all(scopes.splice(0).map((scope) => rm(scope, { recursive: true, force: true })));
});

async function tempScope(): Promise<string> {
	const scope = await mkdtemp(join(tmpdir(), "openrouter-floor-ledger-"));
	scopes.push(scope);
	return scope;
}

describe("floor ledger", () => {
	it("serializes redacted events into a per-process shard and reads valid records", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({ processId: "p-one", now: () => now });
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

		const path = join(ledgerDirectoryFor(scope), "p-one.2026-09-07.jsonl");
		const content = await readFile(path, "utf8");
		assert.doesNotMatch(content, /gen-secret-id/);
		assert.doesNotMatch(content, /Authorization|prompt|response text/i);
		const events = await ledger.read(scope);
		assert.equal(events.length, 2);
		assert.equal(events[0]?.kind, "rewrite");
		assert.equal(events[1]?.kind, "generation");
	});

	it("ignores malformed lines and timestamps outside retention", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({ processId: "p-two", now: () => now });
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
		await appendFile(join(ledgerDirectoryFor(scope), "p-two.jsonl"), '{"version":1,"kind":"rewrite"}\n', "utf8");

		const events = await ledger.read(scope);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.eventId, "p-two:new");
	});

	it("stops appending at the configured shard line limit", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({ processId: "p-three", now: () => now, maxLinesPerShard: 1 });
		await ledger.append(scope, { kind: "rewrite", eventId: "p-three:e1", at: now.toISOString() });
		await ledger.append(scope, { kind: "rewrite", eventId: "p-three:e2", at: now.toISOString() });
		const events = await ledger.read(scope);
		assert.equal(events.length, 1);
		assert.ok(events[0]);
		assert.equal(events[0].eventId, "p-three:e1");
	});

	it("rotates daily so expired events cannot block current telemetry", async () => {
		const scope = await tempScope();
		let clock = new Date("2026-08-01T12:00:00.000Z");
		const ledger = createFloorLedger({ processId: "p-rotate", now: () => clock, maxLinesPerShard: 1 });
		await ledger.append(scope, { kind: "rewrite", eventId: "p-rotate:old", at: clock.toISOString() });

		clock = new Date("2026-09-07T12:00:00.000Z");
		await ledger.append(scope, { kind: "rewrite", eventId: "p-rotate:new", at: clock.toISOString() });

		const events = await ledger.read(scope);
		assert.deepEqual(
			events.map((event) => event.eventId),
			["p-rotate:new"],
		);
		assert.deepEqual(await readdir(ledgerDirectoryFor(scope)), ["p-rotate.2026-09-07.jsonl"]);
	});

	it("reads and accounts for more than 256 retained shards", async () => {
		const scope = await tempScope();
		for (let index = 0; index < 257; index += 1) {
			const processId = `p-many-${index}`;
			const ledger = createFloorLedger({ processId, now: () => now });
			await ledger.append(scope, { kind: "rewrite", eventId: `${processId}:event`, at: now.toISOString() });
		}

		const ledger = createFloorLedger({ processId: "p-reader", now: () => now });
		assert.equal((await ledger.read(scope)).length, 257);
	});

	it("stops appending when the scope byte budget is exhausted", async () => {
		const scope = await tempScope();
		const ledger = createFloorLedger({ processId: "p-four", now: () => now, maxTotalBytes: 1 });
		await ledger.append(scope, { kind: "rewrite", eventId: "p-four:e1", at: now.toISOString() });
		assert.deepEqual(await ledger.read(scope), []);
	});
});
