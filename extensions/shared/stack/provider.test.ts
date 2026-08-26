import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stackProviderFor } from "./provider.ts";

describe("stackProviderFor", () => {
	it("maps fixed providers and both Git provider choices", () => {
		assert.equal(stackProviderFor({ backend: "jj", warnings: [] }), "jj");
		assert.equal(stackProviderFor({ backend: "graphite", warnings: [] }), "graphite");
		assert.equal(stackProviderFor({ backend: "git", gitStackProvider: "github", warnings: [] }), "github");
		assert.equal(stackProviderFor({ backend: "git", gitStackProvider: "none", warnings: [] }), undefined);
	});
});
