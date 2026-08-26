import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChildTranscriptStore } from "./transcript-store.ts";

describe("ChildTranscriptStore", () => {
	it("retains final assistant turns up to 256 KiB", () => {
		const store = new ChildTranscriptStore(() => 1, 0);
		store.addChild("child");
		const text = "a".repeat(200 * 1024);

		store.push("child", {
			kind: "turn_end",
			text,
			turn: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			at: 1,
		});

		const entry = store.getEntries("child")[0];
		assert.equal(entry?.kind, "text");
		if (entry?.kind === "text") assert.equal(entry.text, text);
	});

	it("truncates final assistant turns beyond 256 KiB", () => {
		const store = new ChildTranscriptStore(() => 1, 0);
		store.addChild("child");

		store.push("child", {
			kind: "turn_end",
			text: "a".repeat(260 * 1024),
			turn: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			at: 1,
		});

		const entry = store.getEntries("child")[0];
		assert.equal(entry?.kind, "text");
		if (entry?.kind === "text") assert.match(entry.text, /Output truncated at 262144 bytes/);
	});
});
