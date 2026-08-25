import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stackProviderFor } from "./provider.ts";

describe("stackProviderFor", () => {
	it("maps supported VCS backends to their respective stack providers", () => {
		assert.equal(stackProviderFor("jj"), "jj");
		assert.equal(stackProviderFor("graphite"), "graphite");
		assert.equal(stackProviderFor("git"), undefined);
	});
});
