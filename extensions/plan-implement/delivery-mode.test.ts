import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preflightStack, type ExecFn, type ExecFnResult } from "./delivery-mode.ts";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

function ok(stdout: string, code = 0): ExecFnResult {
	return { code, stdout, stderr: "" };
}
function fail(stderr: string, code = 1): ExecFnResult {
	return { code, stderr, stdout: "" };
}

/** Build injected jj/git exec fakes controlled by behavior flags. */
function fakes(opts: {
	jjVersion?: ExecFnResult | Error;
	workspace?: ExecFnResult;
	gitTop?: ExecFnResult;
	trunk?: ExecFnResult;
} = {}): { jj: ExecFn; git: ExecFn } {
	const jj: ExecFn = async (command, args) => {
		if (args[0] === "--version") {
			if (opts.jjVersion instanceof Error) throw opts.jjVersion;
			return opts.jjVersion ?? ok("jj 0.44.0\n");
		}
		if (args[0] === "workspace" && args[1] === "root") return opts.workspace ?? ok("/repo\n");
		if (args[0] === "log" && args[1] === "-r" && args[2] === "trunk()") return opts.trunk ?? ok(`${FULL_SHA}\n`);
		return fail("unexpected jj call");
	};
	const git: ExecFn = async (_command, args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return opts.gitTop ?? ok("/repo\n");
		return fail("unexpected git call");
	};
	return { jj, git };
}

describe("preflightStack", () => {
	it("resolves the immutable trunk() SHA when jj, a colocated git worktree, and trunk() all succeed", async () => {
		const { jj, git } = fakes();
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.trunkSha, FULL_SHA);
			assert.equal(result.workspaceRoot, "/repo");
		}
	});

	it("fails when jj is not found (exec throws)", async () => {
		const { jj, git } = fakes({ jjVersion: new Error("not found") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /jj/);
	});

	it("fails when jj --version exits nonzero", async () => {
		const { jj, git } = fakes({ jjVersion: fail("boom") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /jj --version/);
	});

	it("fails when jj is older than the required minimum", async () => {
		const { jj, git } = fakes({ jjVersion: ok("jj 0.30.0\n") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /requires jj >= 0\.44/);
	});

	it("fails when the jj version string cannot be parsed", async () => {
		const { jj, git } = fakes({ jjVersion: ok("weird output\n") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /parse jj version/);
	});

	it("fails when the directory is not a jj workspace", async () => {
		const { jj, git } = fakes({ workspace: fail("no repo") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /Jujutsu workspace/);
	});

	it("fails when there is no colocated git worktree", async () => {
		const { jj, git } = fakes({ gitTop: fail("not a git repo") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /colocated Git worktree/);
	});

	it("fails when the jj workspace root and git worktree differ (not colocated)", async () => {
		const { jj, git } = fakes({ workspace: ok("/jj-workspace\n"), gitTop: ok("/unrelated-git-repo\n") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /colocated/);
	});

	it("fails when trunk() resolves to no commits", async () => {
		const { jj, git } = fakes({ trunk: fail("no trunk") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /trunk\(\)/);
	});

	it("fails when trunk() resolves to multiple commits", async () => {
		const { jj, git } = fakes({ trunk: ok(`${FULL_SHA}\n${FULL_SHA}\n`) });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /single immutable base/);
	});

	it("fails when trunk() resolves to a non-40-hex (non-Git-backed) commit id", async () => {
		const { jj, git } = fakes({ trunk: ok("notasha\n") });
		const result = await preflightStack("/repo", jj, git);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /non-Git commit id/);
	});
});
