import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import type { IsolationBase, ManagedWorktreePlan } from "./worktree-plan.ts";
import { planManagedWorktree, resolveIsolationBase } from "./worktree-plan.ts";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function result(code: number, stdout = "", stderr = ""): ExecFnResult {
	return { code, stdout, stderr };
}

function unexpected(args: string[], cwd: string): ExecFnResult {
	return result(1, "", `unexpected in ${cwd}: ${args.join(" ")}`);
}

function planOptions(exec: ExecFn, overrides: { exists?: (path: string) => boolean } = {}) {
	return {
		exec,
		cwd: "/start",
		task: "Add archive search",
		managedRoot: "/managed",
		realpath: (path: string) => path,
		exists: overrides.exists ?? (() => false),
	};
}

describe("resolveIsolationBase", () => {
	it("uses origin's symbolic HEAD and a 40-character SHA", async () => {
		const exec: ExecFn = async (_command, args, options) => {
			if (args.join(" ") === "remote") return result(0, "origin\n");
			if (args.join(" ") === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
				return result(0, "refs/remotes/origin/main\n");
			}
			if (args.join(" ") === "rev-parse --verify refs/remotes/origin/main^{commit}") {
				return result(0, `${BASE_SHA}\n`);
			}
			return unexpected(args, options.cwd);
		};
		const base: IsolationBase | undefined = await resolveIsolationBase(exec, "/repo");
		assert.deepEqual(base, {
			ref: "refs/remotes/origin/main",
			sha: BASE_SHA,
		});
	});

	it("uses a non-origin remote's symbolic HEAD when origin is absent", async () => {
		const exec: ExecFn = async (_command, args, options) => {
			if (args.join(" ") === "remote") return result(0, "upstream\n");
			if (args.join(" ") === "symbolic-ref --quiet refs/remotes/upstream/HEAD") {
				return result(0, "refs/remotes/upstream/trunk\n");
			}
			if (args.join(" ") === "rev-parse --verify refs/remotes/upstream/trunk^{commit}") {
				return result(0, `${BASE_SHA}\n`);
			}
			return unexpected(args, options.cwd);
		};
		assert.deepEqual(await resolveIsolationBase(exec, "/repo"), {
			ref: "refs/remotes/upstream/trunk",
			sha: BASE_SHA,
		});
	});

	it("falls back through local main, local master, and HEAD", async () => {
		const seen: string[] = [];
		const exec: ExecFn = async (_command, args) => {
			if (args.join(" ") === "remote") return result(0, "");
			if (args[0] === "symbolic-ref") return result(1);
			if (args[0] === "rev-parse" && args[1] === "--verify") {
				seen.push(args[2] ?? "");
				if (args[2] === "HEAD^{commit}") return result(0, `${BASE_SHA}\n`);
				return result(1);
			}
			return result(1);
		};
		assert.deepEqual(await resolveIsolationBase(exec, "/repo"), { ref: "HEAD", sha: BASE_SHA });
		assert.deepEqual(seen, [
			"refs/remotes/origin/main^{commit}",
			"refs/remotes/origin/master^{commit}",
			"refs/heads/main^{commit}",
			"refs/heads/master^{commit}",
			"HEAD^{commit}",
		]);
	});
});

describe("planManagedWorktree", () => {
	it("builds a repository id from the normalized basename and common Git dir hash", async () => {
		const exec: ExecFn = async (_command, args, options) => {
			if (args.join(" ") === "rev-parse --show-toplevel") return result(0, "/repo\n");
			if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				return result(0, "/repo/.git\n");
			}
			if (args.join(" ") === "remote") return result(0, "origin\n");
			if (args.join(" ") === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
				return result(0, "refs/remotes/origin/main\n");
			}
			if (args.join(" ") === "rev-parse --verify refs/remotes/origin/main^{commit}") {
				return result(0, `${BASE_SHA}\n`);
			}
			if (args[0] === "show-ref") return result(1);
			return unexpected(args, options.cwd);
		};
		const planned = await planManagedWorktree(planOptions(exec));
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		const allocated: ManagedWorktreePlan = planned;
		const repositoryHash = createHash("sha256").update("/repo/.git").digest("hex").slice(0, 8);
		assert.equal(allocated.repositoryId, `repo-${repositoryHash}`);
		assert.equal(allocated.commonGitDir, "/repo/.git");
		assert.equal(allocated.plan.sourceRepoRoot, "/repo");
		assert.equal(allocated.plan.baseRef, "refs/remotes/origin/main");
		assert.equal(allocated.plan.baseSha, BASE_SHA);
		assert.equal(allocated.plan.baseSha.length, 40);
		assert.equal(allocated.slug, "add-archive-search");
		assert.equal(allocated.plan.ref, "kstack/add-archive-search");
		assert.equal(allocated.plan.path, `/managed/repo-${repositoryHash}/add-archive-search`);
	});

	it("treats an occupied branch as a collision", async () => {
		const exec: ExecFn = async (_command, args) => {
			if (args.join(" ") === "rev-parse --show-toplevel") return result(0, "/repo\n");
			if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				return result(0, "/repo/.git\n");
			}
			if (args.join(" ") === "remote") return result(0, "origin\n");
			if (args.join(" ") === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
				return result(0, "refs/remotes/origin/main\n");
			}
			if (args[0] === "rev-parse" && args[1] === "--verify") return result(0, `${BASE_SHA}\n`);
			if (args[0] === "show-ref") {
				return args.at(-1) === "refs/heads/kstack/add-search" ? result(0) : result(1);
			}
			return result(1);
		};
		const planned = await planManagedWorktree({
			...planOptions(exec),
			task: "Add search",
		});
		assert.equal(planned.ok, true);
		if (planned.ok) {
			assert.equal(planned.slug, "add-search-2");
			assert.equal(planned.plan.ref, "kstack/add-search-2");
		}
	});

	it("treats an existing destination path as a collision even when the branch is free", async () => {
		const exec: ExecFn = async (_command, args) => {
			if (args.join(" ") === "rev-parse --show-toplevel") return result(0, "/repo\n");
			if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				return result(0, "/repo/.git\n");
			}
			if (args.join(" ") === "remote") return result(0, "origin\n");
			if (args.join(" ") === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
				return result(0, "refs/remotes/origin/main\n");
			}
			if (args[0] === "rev-parse" && args[1] === "--verify") return result(0, `${BASE_SHA}\n`);
			if (args[0] === "show-ref") return result(1);
			return result(1);
		};
		const planned = await planManagedWorktree({
			...planOptions(exec, { exists: (path) => path.endsWith("/add-search") }),
			task: "Add search",
		});
		assert.equal(planned.ok, true);
		if (planned.ok) assert.equal(planned.slug, "add-search-2");
	});

	it("fails after 100 collision attempts", async () => {
		const exec: ExecFn = async (_command, args) => {
			if (args.join(" ") === "rev-parse --show-toplevel") return result(0, "/repo\n");
			if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				return result(0, "/repo/.git\n");
			}
			if (args.join(" ") === "remote") return result(0, "origin\n");
			if (args.join(" ") === "symbolic-ref --quiet refs/remotes/origin/HEAD") {
				return result(0, "refs/remotes/origin/main\n");
			}
			if (args[0] === "rev-parse" && args[1] === "--verify") return result(0, `${BASE_SHA}\n`);
			if (args[0] === "show-ref") return result(0);
			return result(1);
		};
		const planned = await planManagedWorktree({ ...planOptions(exec), task: "Add search" });
		assert.equal(planned.ok, false);
		if (!planned.ok) {
			assert.equal(planned.error, "Could not allocate a unique managed worktree after 100 attempts.");
		}
	});

	it("requires a Git working tree", async () => {
		const exec: ExecFn = async (_command, args) => {
			if (args.join(" ") === "rev-parse --show-toplevel") return result(128, "", "not a git repository");
			return result(1);
		};
		assert.deepEqual(await planManagedWorktree(planOptions(exec)), {
			ok: false,
			error: "Worktree mode requires a Git working tree.",
		});
	});
});
