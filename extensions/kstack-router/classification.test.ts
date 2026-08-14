import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRouteAlternatives, formatRecommendation, parseClassifierOutput } from "./classification.ts";
import { CLASSIFIER_SENTINEL_END, CLASSIFIER_SENTINEL_START } from "./types.ts";

function buildEnvelope(body: string): string {
	return `${CLASSIFIER_SENTINEL_START}\n${body}\n${CLASSIFIER_SENTINEL_END}`;
}

describe("parseClassifierOutput", () => {
	it("parses valid envelope", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "investigate",
				confidence: "high",
				rationale: "This is a research task.",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.envelope.route, "investigate");
			assert.equal(result.envelope.confidence, "high");
			assert.equal(result.envelope.rationale, "This is a research task.");
		}
	});

	it("parses envelope with delivery", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "change",
				confidence: "high",
				rationale: "Feature work.",
				delivery: "single",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.envelope.route, "change");
			assert.equal(result.envelope.delivery, "single");
		}
	});

	it("parses a change-kind for change work", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "change",
				confidence: "high",
				rationale: "Regression in the parser.",
				changeKind: "bug-fix",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) assert.equal(result.envelope.changeKind, "bug-fix");
	});

	it("ignores an echoed change-kind outside the change route", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "investigate",
				confidence: "high",
				rationale: "Research.",
				changeKind: "feature",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) assert.equal(result.envelope.changeKind, undefined);
	});

	it("parses envelope with stack delivery", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "change",
				confidence: "medium",
				rationale: "Large feature that benefits from stacking.",
				delivery: "stack",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.envelope.delivery, "stack");
		}
	});

	it("rejects missing sentinels", () => {
		const result = parseClassifierOutput(
			JSON.stringify({ schemaVersion: 1, route: "investigate", confidence: "high", rationale: "test" }),
		);
		assert.ok(!result.ok);
	});

	it("rejects malformed JSON", () => {
		const output = buildEnvelope("not json");
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects empty envelope", () => {
		const output = `${CLASSIFIER_SENTINEL_START}\n${CLASSIFIER_SENTINEL_END}`;
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects unknown schemaVersion", () => {
		const output = buildEnvelope(
			JSON.stringify({ schemaVersion: 2, route: "investigate", confidence: "high", rationale: "test" }),
		);
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects unknown route", () => {
		const output = buildEnvelope(
			JSON.stringify({ schemaVersion: 1, route: "unknown", confidence: "high", rationale: "test" }),
		);
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects invalid confidence", () => {
		const output = buildEnvelope(
			JSON.stringify({ schemaVersion: 1, route: "investigate", confidence: "certain", rationale: "test" }),
		);
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects missing rationale", () => {
		const output = buildEnvelope(
			JSON.stringify({ schemaVersion: 1, route: "investigate", confidence: "high", rationale: "" }),
		);
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects oversized rationale", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "investigate",
				confidence: "high",
				rationale: "x".repeat(501),
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects unknown keys (injection protection)", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "change",
				confidence: "high",
				rationale: "test",
				command: "rm -rf /",
				model: "gpt-5",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects invalid delivery", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "change",
				confidence: "high",
				rationale: "test",
				delivery: "both",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("rejects non-object JSON", () => {
		const output = buildEnvelope('"string"');
		const result = parseClassifierOutput(output);
		assert.ok(!result.ok);
	});

	it("clamps unsupported to low confidence", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "unsupported",
				confidence: "high",
				rationale: "This is autonomous.",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.envelope.confidence, "low");
		}
	});

	it("handles text before/after sentinels", () => {
		const output = `some text before\n${CLASSIFIER_SENTINEL_START}\n${JSON.stringify({ schemaVersion: 1, route: "review", confidence: "medium", rationale: "Review task." })}\n${CLASSIFIER_SENTINEL_END}\nsome text after`;
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.envelope.route, "review");
		}
	});
});

describe("formatRecommendation", () => {
	it("produces readable output", () => {
		const text = formatRecommendation(
			{
				route: "investigate",
				confidence: "high",
				rationale: "Clear research task.",
			},
			"default model",
		);
		assert.ok(text.includes("Investigate"));
		assert.ok(text.includes("High confidence"));
		assert.ok(text.includes("Clear research task."));
	});

	it("includes delivery when provided", () => {
		const text = formatRecommendation(
			{
				route: "change",
				confidence: "high",
				rationale: "Feature work.",
				delivery: "stack",
			},
			"config",
		);
		assert.ok(text.includes("stacked PRs"));
	});
});

describe("buildRouteAlternatives", () => {
	it("returns all routes except the current one and unsupported", () => {
		const alts = buildRouteAlternatives("change");
		const ids = alts.map((a) => a.id);
		assert.ok(!ids.includes("change"));
		assert.ok(!ids.includes("unsupported"));
		assert.ok(ids.includes("investigate"));
		assert.ok(ids.includes("review"));
	});

	it("returns all alt routes when no current route", () => {
		const alts = buildRouteAlternatives();
		const ids = alts.map((a) => a.id);
		assert.ok(!ids.includes("unsupported"));
		assert.ok(ids.length >= 6);
	});
});
