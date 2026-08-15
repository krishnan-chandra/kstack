import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../git-exec.ts";
import { preflightVcs } from "./preflight.ts";

const gitRoot: ExecFn = async (command, args) => {
	assert.equal(command, "git");
	assert.deepEqual(args, ["rev-parse", "--show-toplevel"]);
	return { code: 0, stdout: "/repo\n", stderr: "" };
};

describe("VCS preflight", () => {
	it("accepts a plain Git working tree", async () => {
		assert.deepEqual(await preflightVcs("/repo/src", "git", gitRoot, { exists: () => false }), {
			ok: true,
			workspaceRoot: "/repo",
		});
	});

	it("refuses Git mutation in a jj-managed workspace", async () => {
		const result = await preflightVcs("/repo", "git", gitRoot, { exists: (path) => path === "/repo/.jj" });
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /jj-managed/);
		assert.match(result.ok ? "" : result.error, /setup-kstack/);
	});

	it("rejects a missing Git working tree", async () => {
		const exec: ExecFn = async () => ({ code: 128, stdout: "", stderr: "not a repository" });
		const result = await preflightVcs("/tmp", "git", exec);
		assert.deepEqual(result, { ok: false, error: "The git backend requires a Git working tree." });
	});

	it("turns a missing Git executable into a preflight error", async () => {
		const exec: ExecFn = async () => {
			throw new Error("spawn git ENOENT");
		};
		const result = await preflightVcs("/tmp", "git", exec);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /ENOENT/);
	});
});
