import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNamedSessionChoices } from "./session-choices.ts";

function session(id: string, name?: string, modified = "2026-08-12T17:00:00.000Z") {
	return { path: `/sessions/${id}.jsonl`, id, name, modified: new Date(modified), firstMessage: "unreadable fallback" };
}

describe("named archive session choices", () => {
	it("shows unique names without first-message, timestamp, or id noise", () => {
		const result = buildNamedSessionChoices([
			session("11111111-aaaa", "Archive picker cleanup"),
			session("22222222-bbbb", "Handoff tests"),
		]);
		assert.deepEqual(result.choices.map((choice) => choice.label), ["Archive picker cleanup", "Handoff tests"]);
		assert.equal(result.unnamedCount, 0);
	});

	it("excludes unnamed sessions instead of falling back to their first message", () => {
		const result = buildNamedSessionChoices([session("11111111-aaaa"), session("22222222-bbbb", "Named")]);
		assert.deepEqual(result.choices.map((choice) => choice.label), ["Named"]);
		assert.equal(result.unnamedCount, 1);
	});

	it("adds timestamps only to duplicate names and ids only to exact collisions", () => {
		const result = buildNamedSessionChoices([
			session("11111111-aaaa", "Investigation"),
			session("22222222-bbbb", "Investigation", "2026-08-12T18:00:00.000Z"),
			session("33333333-cccc", "Investigation"),
		]);
		assert.deepEqual(result.choices.map((choice) => choice.label), [
			"Investigation — 2026-08-12T17:00:00.000Z",
			"Investigation — 2026-08-12T18:00:00.000Z",
			"Investigation — 2026-08-12T17:00:00.000Z — 33333333",
		]);
	});
});
