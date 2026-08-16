import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getRepoMethod, type LandConfig, validateLandConfig } from "./config.ts";

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

describe("validateLandConfig", () => {
	it("accepts a valid squash/rebase map", () => {
		const result = validateLandConfig({
			repos: {
				"owner/frontend": "squash",
				"owner/backend": "rebase",
			},
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.config.repos["owner/frontend"], "squash");
			assert.equal(result.config.repos["owner/backend"], "rebase");
		}
	});

	it("accepts an absent repos section as an empty map", () => {
		const result = validateLandConfig({});
		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.config.repos, {});
	});

	it("rejects an invalid method and names the repo key", () => {
		const result = validateLandConfig({ repos: { "owner/frontend": "squahs" } });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /owner\/frontend/);
	});

	it("rejects repos as an array", () => {
		const result = validateLandConfig({ repos: ["squash"] });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /repos/);
	});

	it("rejects a non-object section", () => {
		const result = validateLandConfig(["squash"]);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /object/);
	});
});
