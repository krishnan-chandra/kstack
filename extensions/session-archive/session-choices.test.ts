import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionChoices } from "./session-choices.ts";

function session(
	id: string,
	name?: string,
	modified = "2026-08-12T17:00:00.000Z",
	firstMessage = "Investigate archive behavior",
) {
	return { path: `/sessions/${id}.jsonl`, id, name, modified: new Date(modified), firstMessage };
}

describe("archive session choices", () => {
	it("shows unique names without first-message, timestamp, or id noise", () => {
		const choices = buildSessionChoices([
			session("11111111-aaaa", "Archive picker cleanup"),
			session("22222222-bbbb", "Handoff tests"),
		]);
		assert.deepEqual(
			choices.map((choice) => choice.label),
			["Archive picker cleanup", "Handoff tests"],
		);
	});

	it("includes unnamed sessions with a bounded first-message summary", () => {
		const choices = buildSessionChoices([
			session("11111111-aaaa"),
			session("22222222-bbbb", "Named"),
			session("33333333-cccc", undefined, undefined, ""),
		]);
		assert.deepEqual(
			choices.map((choice) => choice.label),
			["(unnamed) — Investigate archive behavior", "Named", "(unnamed)"],
		);
	});

	it("adds timestamps only to duplicate labels and ids only to exact collisions", () => {
		const choices = buildSessionChoices([
			session("11111111-aaaa", "Investigation"),
			session("22222222-bbbb", "Investigation", "2026-08-12T18:00:00.000Z"),
			session("33333333-cccc", "Investigation"),
		]);
		assert.deepEqual(
			choices.map((choice) => choice.label),
			[
				"Investigation — 2026-08-12T17:00:00.000Z",
				"Investigation — 2026-08-12T18:00:00.000Z",
				"Investigation — 2026-08-12T17:00:00.000Z — 33333333",
			],
		);
	});
});
