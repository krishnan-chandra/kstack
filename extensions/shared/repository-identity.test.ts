import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { ExecFn } from "./git-exec.ts";
import {
	type RepositoryIdentity,
	type RepositoryIdentityDeps,
	resolveRepositoryIdentity,
} from "./repository-identity.ts";

describe("resolveRepositoryIdentity", () => {
	it("returns the canonical common Git directory and its key for git", async () => {
		const exec: ExecFn = async (command, args, options) => {
			assert.equal(command, "git");
			assert.deepEqual(args, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
			assert.equal(options.cwd, "/worktree");
			assert.equal(options.timeout, 8_000);
			return { code: 0, stdout: "/repo/.git\n", stderr: "" };
		};

		const deps = {
			backend: "git",
			realpath: (path: string) => `/canonical${path}`,
		} satisfies RepositoryIdentityDeps;
		const identity: RepositoryIdentity = await resolveRepositoryIdentity(exec, "/worktree", deps);

		assert.deepEqual(identity, {
			ok: true,
			commonGitDir: "/canonical/repo/.git",
			key: createHash("sha256").update("/canonical/repo/.git").digest("hex"),
		});
		if (identity.ok) assert.match(identity.key, /^[a-f0-9]{64}$/);
	});

	it("resolves the explicit Git store before the common directory for jj", async () => {
		const calls: string[][] = [];
		const exec: ExecFn = async (command, args) => {
			calls.push([command, ...args]);
			if (command === "jj") return { code: 0, stdout: "/repo/.git/worktrees/jj\n", stderr: "" };
			return { code: 0, stdout: "/repo/.git\n", stderr: "" };
		};

		const identity = await resolveRepositoryIdentity(exec, "/secondary", {
			backend: "jj",
			realpath: (path) => path,
		});

		assert.equal(identity.ok, true);
		assert.deepEqual(calls, [
			["jj", "git", "root"],
			["git", "--git-dir=/repo/.git/worktrees/jj", "rev-parse", "--path-format=absolute", "--git-common-dir"],
		]);
	});

	it("reports a failed jj Git-store probe", async () => {
		let calls = 0;
		const identity = await resolveRepositoryIdentity(
			async (command) => {
				assert.equal(command, "jj");
				calls += 1;
				return { code: 1, stdout: "", stderr: "no Git backend" };
			},
			"/secondary",
			{ backend: "jj" },
		);

		assert.deepEqual(identity, { ok: false, error: "jj git root: no Git backend" });
		assert.equal(calls, 1);
	});

	it("reports a failed common-directory probe", async () => {
		const identity = await resolveRepositoryIdentity(
			async () => ({ code: 1, stdout: "", stderr: "not a repository" }),
			"/outside",
			{ backend: "git" },
		);

		assert.deepEqual(identity, { ok: false, error: "not a repository" });
	});

	it("reports canonicalization failures", async () => {
		const identity = await resolveRepositoryIdentity(
			async () => ({ code: 0, stdout: "/repo/.git\n", stderr: "" }),
			"/repo",
			{
				realpath: () => {
					throw new Error("permission denied");
				},
			},
		);

		assert.deepEqual(identity, { ok: false, error: "canonicalize: permission denied" });
	});

	it("treats graphite as git", async () => {
		const calls: string[] = [];
		const identity = await resolveRepositoryIdentity(
			async (command) => {
				calls.push(command);
				return { code: 0, stdout: "/repo/.git\n", stderr: "" };
			},
			"/repo",
			{ backend: "graphite", realpath: (path) => path },
		);

		assert.equal(identity.ok, true);
		assert.deepEqual(calls, ["git"]);
	});
});
