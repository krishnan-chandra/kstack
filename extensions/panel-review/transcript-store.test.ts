import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_CHILD_ENTRIES,
	MAX_CHILD_TRANSCRIPT_BYTES,
	MAX_ENTRY_TEXT_BYTES,
	PanelTranscriptStore,
} from "./transcript-store.ts";

describe("PanelTranscriptStore", () => {
	it("initializes empty entries for a new child", () => {
		const store = new PanelTranscriptStore();
		store.addChild("r1");
		assert.deepEqual(store.getEntries("r1"), []);
		assert.equal(store.getLiveTail("r1"), undefined);
		assert.equal(store.wasEvicted("r1"), false);
	});

	it("ignores pushes and notes for unknown children", () => {
		const store = new PanelTranscriptStore();
		let notified = false;
		store.subscribe(() => {
			notified = true;
		});
		store.push("unknown", { kind: "text_delta", delta: "hi", at: 100 });
		store.note("unknown", "started");
		assert.equal(notified, false);
		assert.deepEqual(store.getEntries("unknown"), []);
	});

	it("streams text deltas into the live tail and freezes on turn_end", () => {
		let clock = 1000;
		const store = new PanelTranscriptStore(() => clock);
		store.addChild("r1");

		let emissions = 0;
		store.subscribe(() => {
			emissions++;
		});

		store.push("r1", { kind: "text_delta", delta: "Hello ", at: 1000 });
		assert.equal(store.getLiveTail("r1"), "Hello ");
		assert.equal(emissions, 1);

		store.push("r1", { kind: "text_delta", delta: "World!", at: 1010 });
		assert.equal(store.getLiveTail("r1"), "Hello World!");
		assert.equal(emissions, 2);

		store.push("r1", {
			kind: "turn_end",
			turn: 1,
			text: "Hello World!",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
			at: 1050,
		});

		assert.equal(store.getLiveTail("r1"), undefined);
		const entries = store.getEntries("r1");
		assert.equal(entries.length, 2);
		assert.deepEqual(entries[0], {
			kind: "text",
			text: "Hello World!",
			turn: 1,
			at: 1050,
		});
		assert.deepEqual(entries[1], {
			kind: "turn",
			turn: 1,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 },
			at: 1050,
		});
	});

	it("attaches duration to the preceding tool call on tool_end", () => {
		const store = new PanelTranscriptStore();
		store.addChild("r1");

		store.push("r1", { kind: "tool_start", summary: "read foo.ts", at: 1000 });
		assert.equal(store.getEntries("r1").length, 1);
		assert.deepEqual(store.getEntries("r1")[0], {
			kind: "tool",
			summary: "read foo.ts",
			at: 1000,
		});

		store.push("r1", { kind: "tool_end", durationMs: 250, at: 1250 });
		const entries = store.getEntries("r1");
		assert.equal(entries.length, 1);
		assert.deepEqual(entries[0], {
			kind: "tool",
			summary: "read foo.ts",
			durationMs: 250,
			at: 1000,
		});
	});

	it("drops tool_end when last entry is not tool or already has duration", () => {
		const store = new PanelTranscriptStore();
		store.addChild("r1");

		store.push("r1", { kind: "tool_start", summary: "read foo.ts", at: 1000 });
		store.push("r1", { kind: "tool_end", durationMs: 200, at: 1200 });
		// Second tool_end should be dropped
		store.push("r1", { kind: "tool_end", durationMs: 300, at: 1300 });
		assert.equal(store.getEntries("r1").length, 1);
		if (store.getEntries("r1")[0].kind === "tool") {
			assert.equal((store.getEntries("r1")[0] as any).durationMs, 200);
		}
	});

	it("adds lifecycle notes with injected clock", () => {
		let clock = 5000;
		const store = new PanelTranscriptStore(() => clock);
		store.addChild("r1");

		store.note("r1", "Reviewer started");
		assert.equal(store.getEntries("r1").length, 1);
		assert.deepEqual(store.getEntries("r1")[0], {
			kind: "note",
			text: "Reviewer started",
			at: 5000,
		});
	});

	it("evicts oldest entries when entry count exceeds limit", () => {
		const store = new PanelTranscriptStore();
		store.addChild("r1");

		for (let i = 0; i < MAX_CHILD_ENTRIES + 10; i++) {
			store.push("r1", { kind: "tool_start", summary: `tool-${i}`, at: i });
		}

		assert.equal(store.wasEvicted("r1"), true);
		const entries = store.getEntries("r1");
		assert.equal(entries.length, MAX_CHILD_ENTRIES);
		if (entries[0].kind === "tool") {
			assert.equal(entries[0].summary, "tool-10");
		}
	});

	it("evicts oldest entries when byte capacity exceeds limit", () => {
		const store = new PanelTranscriptStore();
		store.addChild("r1");

		// Each text entry has ~4 KiB
		const chunk = "a".repeat(4 * 1024);
		const totalChunks = Math.ceil(MAX_CHILD_TRANSCRIPT_BYTES / (4 * 1024)) + 5;

		for (let i = 0; i < totalChunks; i++) {
			store.push("r1", {
				kind: "turn_end",
				turn: i + 1,
				text: `chunk-${i}:${chunk}`,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
				at: i,
			});
		}

		assert.equal(store.wasEvicted("r1"), true);
		const entries = store.getEntries("r1");
		// Ensure first chunks were evicted
		const firstText = entries.find((e) => e.kind === "text");
		assert.ok(firstText && firstText.kind === "text");
		assert.ok(!firstText.text.startsWith("chunk-0:"));
	});

	it("truncates oversized entry text", () => {
		const store = new PanelTranscriptStore();
		store.addChild("r1");

		const huge = "x".repeat(MAX_ENTRY_TEXT_BYTES * 2);
		store.note("r1", huge);

		const entries = store.getEntries("r1");
		assert.equal(entries.length, 1);
		if (entries[0].kind === "note") {
			assert.ok(Buffer.byteLength(entries[0].text, "utf8") <= MAX_ENTRY_TEXT_BYTES + 100);
			assert.match(entries[0].text, /truncated/);
		}
	});

	it("allows unsubscribing listener", () => {
		const store = new PanelTranscriptStore();
		store.addChild("r1");
		let count = 0;
		const unsub = store.subscribe(() => {
			count++;
		});
		store.note("r1", "one");
		assert.equal(count, 1);
		unsub();
		store.note("r1", "two");
		assert.equal(count, 1);
	});
});
