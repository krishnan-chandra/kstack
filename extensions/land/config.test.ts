import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRepoMethod, type LandConfig } from "./config.ts";

describe("getRepoMethod", () => {
	const config: LandConfig = {
		repos: {
			"owner/frontend": "squash",
			"owner/backend": "rebase",
		},
	};

	it("returns configured method for a known repository", () => {
		assert.equal(getRepoMethod(config, "owner/frontend"), "squash");
		assert.equal(getRepoMethod(config, "owner/backend"), "rebase");
	});

	it("returns undefined for an unconfigured repository", () => {
		assert.equal(getRepoMethod(config, "owner/other"), undefined);
		assert.equal(getRepoMethod(config, "unknown/repo"), undefined);
	});

	it("returns undefined for an empty config", () => {
		assert.equal(getRepoMethod({ repos: {} }, "owner/frontend"), undefined);
	});
});
