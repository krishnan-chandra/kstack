import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { preflightJjStack } from "./preflight.ts";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

function ok(stdout: string, code = 0): ExecFnResult {
	return { code, stdout, stderr: "" };
}
function fail(stderr: string, code = 1): ExecFnResult {
	return { code, stderr, stdout: "" };
}

function fakeExec(
	opts: {
		jjVersion?: ExecFnResult | Error;
		workspace?: ExecFnResult;
		gitTop?: ExecFnResult;
		trunk?: ExecFnResult;
		name?: ExecFnResult;
		email?: ExecFnResult;
	} = {},
): ExecFn {
	return async (command, args) => {
		if (command === "jj" && args[0] === "--version") {
			if (opts.jjVersion instanceof Error) throw opts.jjVersion;
			return opts.jjVersion ?? ok("jj 0.44.0\n");
		}
		if (command === "jj" && args[0] === "workspace" && args[1] === "root") return opts.workspace ?? ok("/repo\n");
		if (command === "git" && args[0] === "rev-parse") return opts.gitTop ?? ok("/repo\n");
		if (command === "jj" && args[0] === "config" && args[2] === "user.name") return opts.name ?? ok("User\n");
		if (command === "jj" && args[0] === "config" && args[2] === "user.email")
			return opts.email ?? ok("user@example.com\n");
		if (command === "jj" && args[0] === "log" && args[2] === "trunk()") return opts.trunk ?? ok(`${FULL_SHA}\n`);
		return fail(`unexpected call: ${command} ${args.join(" ")}`);
	};
}

describe("preflightJjStack", () => {
	it("resolves the immutable trunk() SHA and child policy after the shared jj preflight", async () => {
		const result = await preflightJjStack("/repo", fakeExec());
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.trunkSha, FULL_SHA);
			assert.equal(result.workspaceRoot, "/repo");
			assert.equal(result.trunkRef, "trunk()");
			assert.match(result.childPolicy, /Local jj stack policy/);
		}
	});

	it("fails when jj is not found", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ jjVersion: new Error("not found") }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /jj/);
	});

	it("fails when jj is older than the required minimum", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ jjVersion: ok("jj 0.30.0\n") }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /requires jj >= 0\.44/);
	});

	it("fails when the directory is not a jj workspace", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ workspace: fail("no repo") }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /Jujutsu workspace/);
	});

	it("fails when there is no colocated git worktree", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ gitTop: fail("not a git repo") }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /colocated Git worktree/);
	});

	it("fails when the jj workspace root and git worktree differ", async () => {
		const result = await preflightJjStack(
			"/repo",
			fakeExec({ workspace: ok("/jj-workspace\n"), gitTop: ok("/unrelated-git-repo\n") }),
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /differ/);
	});

	it("fails when the jj identity is incomplete", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ email: fail("unset") }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /user\.email/);
	});

	it("fails when trunk() cannot be resolved", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ trunk: fail("no trunk") }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /trunk\(\)/);
	});

	it("fails when trunk() resolves to multiple commits", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ trunk: ok(`${FULL_SHA}\n${FULL_SHA}\n`) }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /single immutable base/);
	});

	it("fails when trunk() resolves to a non-Git-backed commit id", async () => {
		const result = await preflightJjStack("/repo", fakeExec({ trunk: ok("notasha\n") }));
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /non-Git commit id/);
	});
});
