import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isChildModelAvailable, type ChildModelRegistry } from "./model-availability.ts";

function registry(options: { registered?: string[]; found?: boolean; authenticated?: boolean } = {}): ChildModelRegistry {
	const model = { provider: "a", id: "m" };
	return {
		getRegisteredProviderIds: () => options.registered ?? [],
		find: () => options.found === false ? undefined : model,
		hasConfiguredAuth: () => options.authenticated !== false,
	};
}

describe("isChildModelAvailable", () => {
	it("accepts authenticated catalogue/models.json providers that survive --no-extensions", () => {
		assert.equal(isChildModelAvailable(registry(), "a", "m"), true);
	});

	it("rejects missing or unauthenticated models", () => {
		assert.equal(isChildModelAvailable(registry({ found: false }), "a", "m"), false);
		assert.equal(isChildModelAvailable(registry({ authenticated: false }), "a", "m"), false);
	});

	it("rejects extension-registered providers even when the parent resolves the model", () => {
		assert.equal(isChildModelAvailable(registry({ registered: ["a"] }), "a", "m"), false);
	});
});
