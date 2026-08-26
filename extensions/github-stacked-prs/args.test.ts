import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeGitHubStackArgs, parseGitHubStackArgs } from "./args.ts";

describe("/gh-stack arguments", () => {
	it("parses the one publish action", () => {
		assert.deepEqual(parseGitHubStackArgs("publish --top kstack/top --remote upstream --ready"), {
			ok: true,
			command: { action: "publish", top: "kstack/top", remote: "upstream", ready: true },
		});
	});

	it("lists only publish in usage errors", () => {
		const result = parseGitHubStackArgs("inspect");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /publish --top/);
		assert.doesNotMatch(result.ok ? "" : result.error, /inspect|plan|sync|advance/);
	});

	it("rejects non-owned tops and completes the bounded surface", () => {
		assert.equal(parseGitHubStackArgs("publish --top feature").ok, false);
		assert.deepEqual(completeGitHubStackArgs("pub"), [{ value: "publish", label: "publish" }]);
		assert.deepEqual(completeGitHubStackArgs("publish --r"), [
			{ value: "publish --remote", label: "--remote" },
			{ value: "publish --ready", label: "--ready" },
		]);
	});
});
