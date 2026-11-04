import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyRewrite, decideRewrite, hasVariant } from "./floor-rewrite.ts";

const model = { provider: "openrouter", id: "openai/gpt-5.6-sol" };
it("detects variants only after the author segment", () => {
	assert.equal(hasVariant(model.id), false);
	assert.equal(hasVariant("weird:author/model"), false);
	for (const suffix of ["floor", "nitro", "free"]) assert.equal(hasVariant(`${model.id}:${suffix}`), true);
});
for (const variant of ["floor", "nitro"] as const) {
	describe(variant, () => {
		it("changes only the model and does not mutate the input", () => {
			const payload = { model: model.id, messages: [], stream: true, provider: { order: ["test"] } };
			assert.deepEqual(decideRewrite(payload, model, variant), {
				model: `${model.id}:${variant}`,
				reason: "rewritten",
			});
			assert.deepEqual(applyRewrite(payload, model, variant), { ...payload, model: `${model.id}:${variant}` });
			assert.equal(payload.model, model.id);
		});
		it("preserves all safety guards in order", () => {
			assert.deepEqual(decideRewrite({}, undefined, variant), { reason: "no-model" });
			assert.deepEqual(decideRewrite({}, { ...model, provider: "openai" }, variant), { reason: "not-openrouter" });
			for (const payload of [{}, undefined, { model: 42 }, { model: "other/model" }]) {
				assert.deepEqual(decideRewrite(payload, model, variant), { reason: "payload-model-mismatch" });
				assert.equal(applyRewrite(payload, model, variant), undefined);
			}
			for (const suffix of ["floor", "nitro", "free"]) {
				const suffixed = { ...model, id: `${model.id}:${suffix}` };
				assert.deepEqual(decideRewrite({ model: suffixed.id }, suffixed, variant), { reason: "already-variant" });
				assert.equal(applyRewrite({ model: suffixed.id }, suffixed, variant), undefined);
			}
		});
	});
}
it("none passes through after safety checks", () => {
	assert.deepEqual(decideRewrite({ model: model.id }, model, "none"), { reason: "policy-none" });
	assert.equal(applyRewrite({ model: model.id }, model, "none"), undefined);
	assert.deepEqual(decideRewrite({}, model, "none"), { reason: "payload-model-mismatch" });
});
