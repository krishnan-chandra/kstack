import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	EVICTION_NOTICE,
	MAX_CHILD_ENTRIES,
	MAX_CHILD_TRANSCRIPT_BYTES,
	MAX_ENTRY_TEXT_BYTES,
	PlanImplementTranscriptStore,
	type TranscriptEntry,
} from "./transcript-store.ts";

describe("PlanImplementTranscriptStore", () => {
	it("initializes empty entries for a new child", () => {
		const store = new PlanImplementTranscriptStore();
		store.addChild("planner");
		assert.deepEqual(store.getEntries("planner"), []);
		assert.equal(store.getLiveTail("planner"), undefined);
		assert.equal(store.wasEvicted("planner"), false);
	});

	it("ignores pushes and notes for unknown children", () => {
		const store = new PlanImplementTranscriptStore();
		store.push("unknown", { kind: "text_delta", delta: "hi", at: 100 });
		store.note("unknown", "hello");
		assert.deepEqual(store.getEntries("unknown"), []);
	});

	it("streams text deltas into the live tail and freezes on turn_end", () => {
		const store = new PlanImplementTranscriptStore(() => 1000, 0);
		store.addChild("implementer");
		store.push("implementer", { kind: "text_delta", delta: "Hello ", at: 100 });
		store.push("implementer", { kind: "text_delta", delta: "world", at: 200 });
		assert.equal(store.getLiveTail("implementer"), "Hello world");

		store.push("implementer", {
			kind: "turn_end",
			turn: 1,
			text: "Hello world",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
			at: 300,
		});
		assert.equal(store.getLiveTail("implementer"), undefined);
		const entries = store.getEntries("implementer");
		assert.equal(entries.length, 2);
		assert.equal(entries[0].kind, "text");
		assert.equal((entries[0] as Extract<TranscriptEntry, { kind: "text" }>).text, "Hello world");
		assert.equal(entries[1].kind, "turn");
	});

	it("coalesces text_delta emissions when throttling is enabled", async () => {
		let emissions = 0;
		const store = new PlanImplementTranscriptStore(() => 1000, 50);
		store.addChild("planner");
		store.subscribe(() => {
			emissions++;
		});

		store.push("planner", { kind: "text_delta", delta: "a", at: 100 });
		store.push("planner", { kind: "text_delta", delta: "b", at: 110 });
		store.push("planner", { kind: "text_delta", delta: "c", at: 120 });
		assert.equal(emissions, 0);

		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(emissions, 1);
		assert.equal(store.getLiveTail("planner"), "abc");
		store.dispose();
	});

	it("flushes throttled emission immediately on turn_end or flush()", () => {
		let emissions = 0;
		const store = new PlanImplementTranscriptStore(() => 1000, 500);
		store.addChild("planner");
		store.subscribe(() => {
			emissions++;
		});

		store.push("planner", { kind: "text_delta", delta: "chunk", at: 100 });
		assert.equal(emissions, 0);
		store.flush();
		assert.equal(emissions, 1);
		store.dispose();
	});

	it("attaches duration to the preceding tool call on tool_end", () => {
		const store = new PlanImplementTranscriptStore(() => 1000, 0);
		store.addChild("implementer");
		store.push("implementer", { kind: "tool_start", summary: "grep pattern", at: 100 });
		assert.equal(store.getEntries("implementer").length, 1);
		const toolEntry = store.getEntries("implementer")[0];
		assert.equal(toolEntry.kind, "tool");
		if (toolEntry.kind === "tool") {
			assert.equal(toolEntry.durationMs, undefined);
		}

		store.push("implementer", { kind: "tool_end", durationMs: 250, at: 350 });
		const updated = store.getEntries("implementer")[0];
		assert.equal(updated.kind, "tool");
		if (updated.kind === "tool") {
			assert.equal(updated.durationMs, 250);
		}
	});

	it("adds lifecycle notes with injected clock", () => {
		let now = 1000;
		const store = new PlanImplementTranscriptStore(() => now, 0);
		store.addChild("planner");
		store.note("planner", "Planner started");
		now = 2000;
		store.note("planner", "Planner completed");

		const entries = store.getEntries("planner");
		assert.equal(entries.length, 2);
		assert.deepEqual(entries[0], { kind: "note", text: "Planner started", at: 1000 });
		assert.deepEqual(entries[1], { kind: "note", text: "Planner completed", at: 2000 });
	});

	it("evicts oldest entries when entry count exceeds limit", () => {
		const store = new PlanImplementTranscriptStore(() => 1000, 0);
		store.addChild("planner");
		for (let i = 0; i < MAX_CHILD_ENTRIES + 5; i++) {
			store.note("planner", `note ${i}`);
		}
		const entries = store.getEntries("planner");
		assert.equal(entries.length, MAX_CHILD_ENTRIES);
		assert.equal(store.wasEvicted("planner"), true);
		assert.equal((entries[0] as Extract<TranscriptEntry, { kind: "note" }>).text, "note 5");
		assert.equal(EVICTION_NOTICE.includes("128 KiB"), true);
	});

	it("evicts oldest entries when byte capacity exceeds limit", () => {
		const store = new PlanImplementTranscriptStore(() => 1000, 0);
		store.addChild("implementer");
		const largeText = "x".repeat(MAX_ENTRY_TEXT_BYTES);
		const entriesNeeded = Math.ceil(MAX_CHILD_TRANSCRIPT_BYTES / MAX_ENTRY_TEXT_BYTES) + 2;
		for (let i = 0; i < entriesNeeded; i++) {
			store.note("implementer", largeText);
		}
		assert.equal(store.wasEvicted("implementer"), true);
	});

	it("truncates oversized entry text", () => {
		const store = new PlanImplementTranscriptStore(() => 1000, 0);
		store.addChild("planner");
		store.note("planner", "a".repeat(MAX_ENTRY_TEXT_BYTES + 100));
		const entries = store.getEntries("planner");
		assert.equal(entries.length, 1);
		assert.match((entries[0] as Extract<TranscriptEntry, { kind: "note" }>).text, /truncated at/);
	});
});
