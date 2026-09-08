import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type GenerationKeyHash, hashGenerationId, type LedgerEvent } from "./floor-ledger.ts";
import { aggregateFloorReport, formatFloorReport, parseStatsRange } from "./floor-report.ts";

const processId = "p-test";
const scopeKey = "a".repeat(64);
const now = new Date("2026-09-07T12:00:00.000Z");

function rewrite(eventId: string, at: string, owner = processId): LedgerEvent {
	return { version: 1, kind: "rewrite", eventId, processId: owner, scopeKey, at };
}

function generation(
	eventId: string,
	at: string,
	state: "observed" | "resolved",
	tier: "flex" | "default" | "priority" | "unknown",
	generationKeyHash?: GenerationKeyHash,
	reason?: "pending" | "no-response-id" | "lookup-failed" | "null-or-unrecognized-tier" | "invalid-response",
): LedgerEvent {
	const event: LedgerEvent = {
		version: 1,
		kind: "generation",
		eventId,
		processId,
		scopeKey,
		at,
		state,
		tier,
	};
	if (generationKeyHash !== undefined) event.generationKeyHash = generationKeyHash;
	if (reason !== undefined) event.reason = reason;
	return event;
}

describe("aggregateFloorReport", () => {
	it("keeps rewrite coverage separate and prefers a known resolution", () => {
		const key = hashGenerationId("gen-flex");
		const events: LedgerEvent[] = [
			rewrite("e1", "2026-09-07T10:00:00.000Z"),
			rewrite("e2", "2026-09-07T10:01:00.000Z"),
			generation("g1", "2026-09-07T10:02:00.000Z", "observed", "unknown", key, "pending"),
			generation("g1", "2026-09-07T10:02:01.000Z", "resolved", "flex", key),
			generation("g2", "2026-09-07T10:03:00.000Z", "observed", "unknown", hashGenerationId("gen-default"), "pending"),
			generation("g2", "2026-09-07T10:03:01.000Z", "resolved", "default", hashGenerationId("gen-default")),
			generation("g3", "2026-09-07T10:04:00.000Z", "observed", "unknown", undefined, "no-response-id"),
		];

		const report = aggregateFloorReport(events, { range: "today", now });
		assert.equal(report.rewrites, 2);
		assert.equal(report.completedGenerations, 3);
		assert.deepEqual(report.tiers, { flex: 1, default: 1, priority: 0, unknown: 1 });
		assert.equal(report.metadataCoverage, 2 / 3);
		assert.equal(report.flexAmongKnownTiers, 1 / 2);
	});

	it("deduplicates identified generations and filters process range to this process", () => {
		const key = hashGenerationId("duplicate");
		const events: LedgerEvent[] = [
			generation("g1", "2026-09-07T10:00:00.000Z", "observed", "unknown", key, "pending"),
			generation("g1", "2026-09-07T10:01:00.000Z", "resolved", "priority", key),
			generation("other", "2026-09-07T10:01:00.000Z", "resolved", "flex", hashGenerationId("other"), undefined),
			generation("g-old", "2026-08-01T10:00:00.000Z", "resolved", "flex", hashGenerationId("old"), undefined),
		];
		events[2] = { ...events[2], processId: "p-other" };
		events[3] = { ...events[3], processId: "p-other" };
		const report = aggregateFloorReport(events, { range: "process", now, processId });
		assert.equal(report.completedGenerations, 1);
		assert.equal(report.tiers.priority, 1);
	});

	it("reports conflicting known resolutions without hiding the newest one", () => {
		const diagnostics: string[] = [];
		const key = hashGenerationId("conflict");
		const report = aggregateFloorReport(
			[
				generation("g-conflict", "2026-09-07T10:00:00.000Z", "resolved", "flex", key),
				generation("g-conflict", "2026-09-07T10:01:00.000Z", "resolved", "default", key),
			],
			{ range: "today", now, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
		);
		assert.equal(report.tiers.default, 1);
		assert.deepEqual(diagnostics, ["conflicting generation tier resolutions"]);
	});
});

describe("stats command helpers", () => {
	it("parses bounded ranges and defaults to thirty days", () => {
		assert.deepEqual(parseStatsRange(""), { ok: true, value: "30d" });
		assert.deepEqual(parseStatsRange("7d"), { ok: true, value: "7d" });
		assert.equal(parseStatsRange("90d").ok, false);
		assert.equal(parseStatsRange("7d extra").ok, false);
	});

	it("formats unknowns and separate populations without network details", () => {
		const text = formatFloorReport({
			range: "30d",
			rewrites: 2,
			completedGenerations: 3,
			tiers: { flex: 1, default: 1, priority: 0, unknown: 1 },
			metadataCoverage: 2 / 3,
			flexAmongKnownTiers: 1 / 2,
		});
		assert.match(text, /Floor rewrites observed\s+2/);
		assert.match(text, /Unknown includes missing response IDs/);
		assert.doesNotMatch(text, /generation-id|Authorization|prompt/i);
	});
});
