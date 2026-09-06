import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFloor, decideFloor, hasVariant } from "./floor-rewrite.ts";

const sol = { provider: "openrouter", id: "openai/gpt-5.6-sol" };

describe("hasVariant", () => {
	it("detects OpenRouter variant suffixes after the author segment", () => {
		assert.equal(hasVariant("openai/gpt-5.6-sol"), false);
		assert.equal(hasVariant("openai/gpt-5.6-sol:floor"), true);
		assert.equal(hasVariant("meta-llama/llama-3.3-70b-instruct:free"), true);
		assert.equal(hasVariant("anthropic/claude-opus-4.6:nitro"), true);
	});

	it("ignores colons inside the author segment", () => {
		assert.equal(hasVariant("weird:author/model"), false);
	});
});

describe("decideFloor", () => {
	it("appends :floor to a plain OpenRouter model", () => {
		assert.deepEqual(decideFloor({ model: "openai/gpt-5.6-sol", messages: [] }, sol), {
			model: "openai/gpt-5.6-sol:floor",
			reason: "rewritten",
		});
	});

	it("leaves requests alone when no session model is known", () => {
		assert.deepEqual(decideFloor({ model: "openai/gpt-5.6-sol" }, undefined), { reason: "no-model" });
	});

	it("leaves non-OpenRouter providers alone even when the id looks routable", () => {
		const direct = { provider: "openai", id: "gpt-5.6-sol" };
		assert.deepEqual(decideFloor({ model: "gpt-5.6-sol" }, direct), { reason: "not-openrouter" });
	});

	it("leaves requests alone when the payload was built for a different model", () => {
		assert.deepEqual(decideFloor({ model: "google/gemini-3.8-flash" }, sol), {
			reason: "payload-model-mismatch",
		});
		assert.deepEqual(decideFloor({}, sol), { reason: "payload-model-mismatch" });
		assert.deepEqual(decideFloor(undefined, sol), { reason: "payload-model-mismatch" });
		assert.deepEqual(decideFloor({ model: 42 }, sol), { reason: "payload-model-mismatch" });
	});

	it("does not stack variants", () => {
		const floor = { provider: "openrouter", id: "openai/gpt-5.6-sol:floor" };
		assert.deepEqual(decideFloor({ model: floor.id }, floor), { reason: "already-variant" });
		const free = { provider: "openrouter", id: "meta-llama/llama-3.3-70b-instruct:free" };
		assert.deepEqual(decideFloor({ model: free.id }, free), { reason: "already-variant" });
	});
});

describe("applyFloor", () => {
	it("returns a new payload with only the model changed", () => {
		const payload = { model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], stream: true };
		const result = applyFloor(payload, sol);
		assert.deepEqual(result, { ...payload, model: "openai/gpt-5.6-sol:floor" });
		assert.equal(payload.model, "openai/gpt-5.6-sol", "input payload is not mutated");
	});

	it("returns undefined so Pi keeps its payload when no rewrite applies", () => {
		assert.equal(
			applyFloor({ model: "openai/gpt-5.6-sol:floor" }, { ...sol, id: "openai/gpt-5.6-sol:floor" }),
			undefined,
		);
		assert.equal(applyFloor({ model: "gpt-5.6-sol" }, { provider: "openai", id: "gpt-5.6-sol" }), undefined);
	});
});
