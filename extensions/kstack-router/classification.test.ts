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

	it("accepts but ignores echoed delivery and change-kind fields", () => {
		const output = buildEnvelope(
			JSON.stringify({
				schemaVersion: 1,
				route: "investigate",
				confidence: "high",
				rationale: "Research.",
				delivery: "stack",
				changeKind: "feature",
			}),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.envelope.route, "investigate");
		}
	});

	it("rejects the removed change and fast-change routes", () => {
		for (const route of ["change", "fast-change"]) {
			const result = parseClassifierOutput(
				buildEnvelope(JSON.stringify({ schemaVersion: 1, route, confidence: "high", rationale: "Implement." })),
			);
			assert.ok(!result.ok);
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

	it("accepts the review route", () => {
		const output = buildEnvelope(
			JSON.stringify({ schemaVersion: 1, route: "review", confidence: "high", rationale: "Review the diff." }),
		);
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) assert.equal(result.envelope.route, "review");
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
				route: "investigate",
				confidence: "high",
				rationale: "test",
				command: "rm -rf /",
				model: "gpt-5",
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

	it("parses post-PR routes without extra option fields", () => {
		for (const route of ["pr-autopilot", "land"] as const) {
			const result = parseClassifierOutput(
				buildEnvelope(
					JSON.stringify({
						schemaVersion: 1,
						route,
						confidence: "high",
						rationale: "A GitHub PR already exists.",
					}),
				),
			);
			assert.ok(result.ok);
			if (result.ok) {
				assert.equal(result.envelope.route, route);
			}
		}
	});

	it("handles text before/after sentinels", () => {
		const output = `some text before\n${CLASSIFIER_SENTINEL_START}\n${JSON.stringify({ schemaVersion: 1, route: "investigate", confidence: "medium", rationale: "Research task." })}\n${CLASSIFIER_SENTINEL_END}\nsome text after`;
		const result = parseClassifierOutput(output);
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.envelope.route, "investigate");
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
});

describe("buildRouteAlternatives", () => {
	it("returns all routes except the current one and unsupported", () => {
		const alts = buildRouteAlternatives("investigate");
		const ids = alts.map((a) => a.id);
		assert.ok(!ids.includes("investigate"));
		assert.ok(!ids.includes("unsupported"));
		assert.ok(ids.includes("review"));
		assert.ok(ids.includes("session-pickup"));
		assert.ok(ids.includes("pr-autopilot"));
		assert.ok(ids.includes("land"));
	});

	it("returns all alt routes when no current route", () => {
		const alts = buildRouteAlternatives();
		const ids = alts.map((a) => a.id);
		assert.ok(!ids.includes("unsupported"));
		assert.ok(ids.length >= 6);
	});
});
