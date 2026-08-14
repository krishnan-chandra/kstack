import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "./git-exec.ts";
import { createManagedWorktree, planManagedWorktree, slugifyWorktreeTask } from "./worktree.ts";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

function result(code: number, stdout = "", stderr = ""): ExecFnResult {
	return { code, stdout, stderr };
}

function fakeGit(options: { occupiedBranches?: Set<string>; addResult?: ExecFnResult } = {}) {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	const exec: ExecFn = async (_command, args, execOptions) => {
		calls.push({ args, cwd: execOptions.cwd });
		if (args.join(" ") === "rev-parse --show-toplevel")
			return result(0, `${execOptions.cwd === "/start" ? "/repo" : execOptions.cwd}\n`);
		if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") return result(0, "/repo/.git\n");
		if (args.join(" ") === "symbolic-ref --quiet refs/remotes/origin/HEAD")
			return result(0, "refs/remotes/origin/main\n");
		if (args[0] === "rev-parse" && args[1] === "--verify") return result(0, `${BASE_SHA}\n`);
		if (args[0] === "show-ref") {
			const branch = args.at(-1)!.replace("refs/heads/", "");
			return options.occupiedBranches?.has(branch) ? result(0) : result(1);
		}
		if (args[0] === "worktree" && args[1] === "add") return options.addResult ?? result(0);
		return result(1, "", `unexpected: ${args.join(" ")}`);
	};
	return { exec, calls };
}

describe("managed Git worktrees", () => {
	it("builds bounded slugs", () => {
		assert.equal(slugifyWorktreeTask(" Add Archive Search! "), "add-archive-search");
		assert.equal(slugifyWorktreeTask("日本語"), "change");
		assert.ok(slugifyWorktreeTask("x".repeat(100)).length <= 48);
	});

	it("plans beneath the managed root using a repo identity hash and pinned base", async () => {
		const { exec } = fakeGit();
		const planned = await planManagedWorktree("/start", "Add archive search", exec, {
			managedRoot: "/managed",
			realpath: (path) => path,
			exists: () => false,
		});
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		assert.match(planned.plan.repositoryId, /^repo-[0-9a-f]{8}$/);
		assert.equal(planned.plan.path, `/managed/${planned.plan.repositoryId}/add-archive-search`);
		assert.equal(planned.plan.branch, "kstack/add-archive-search");
		assert.equal(planned.plan.baseRef, "refs/remotes/origin/main");
		assert.equal(planned.plan.baseSha, BASE_SHA);
	});

	it("uses a non-origin remote's symbolic default branch", async () => {
		const exec: ExecFn = async (_command, args, options) => {
			if (args.join(" ") === "rev-parse --show-toplevel") return result(0, "/repo\n");
			if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") return result(0, "/repo/.git\n");
			if (args.join(" ") === "remote") return result(0, "upstream\n");
			if (args.join(" ") === "symbolic-ref --quiet refs/remotes/upstream/HEAD")
				return result(0, "refs/remotes/upstream/trunk\n");
			if (args.join(" ") === "rev-parse --verify refs/remotes/upstream/trunk^{commit}")
				return result(0, `${BASE_SHA}\n`);
			if (args[0] === "show-ref") return result(1);
			return result(1, "", `unexpected in ${options.cwd}: ${args.join(" ")}`);
		};
		const planned = await planManagedWorktree("/repo", "Add search", exec, {
			managedRoot: "/managed",
			realpath: (path) => path,
			exists: () => false,
		});
		assert.equal(planned.ok, true);
		if (planned.ok) assert.equal(planned.plan.baseRef, "refs/remotes/upstream/trunk");
	});

	it("adds a numeric suffix when a branch is already present", async () => {
		const { exec } = fakeGit({ occupiedBranches: new Set(["kstack/add-search"]) });
		const planned = await planManagedWorktree("/start", "Add search", exec, {
			managedRoot: "/managed",
			realpath: (path) => path,
			exists: () => false,
		});
		assert.equal(planned.ok, true);
		if (planned.ok) assert.equal(planned.plan.slug, "add-search-2");
	});

	it("creates only the repository namespace and invokes git without a shell", async () => {
		const { exec, calls } = fakeGit();
		const planned = await planManagedWorktree("/start", "Add search", exec, {
			managedRoot: "/managed",
			realpath: (path) => path,
			exists: () => false,
		});
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		const made: string[] = [];
		const created = await createManagedWorktree(planned.plan, exec, {
			exists: () => false,
			realpath: (path) => path,
			mkdir: (path) => void made.push(path),
		});
		assert.equal(created.ok, true);
		assert.deepEqual(made, [`/managed/${planned.plan.repositoryId}`]);
		assert.ok(
			calls.some(
				(call) =>
					call.args.join(" ") ===
					`worktree add --no-guess-remote -b ${planned.plan.branch} ${planned.plan.path} ${BASE_SHA}`,
			),
		);
	});

	it("revalidates collisions immediately before creation", async () => {
		const { exec } = fakeGit({ occupiedBranches: new Set(["kstack/add-search"]) });
		const plan = {
			sourceRepoRoot: "/repo",
			commonGitDir: "/repo/.git",
			managedRoot: "/managed",
			repositoryId: "repo-12345678",
			slug: "add-search",
			branch: "kstack/add-search",
			path: "/managed/repo-12345678/add-search",
			baseRef: "refs/remotes/origin/main",
			baseSha: BASE_SHA,
		};
		const created = await createManagedWorktree(plan, exec, { exists: () => false, mkdir: () => {} });
		assert.equal(created.ok, false);
		if (!created.ok) assert.match(created.error, /Nothing was overwritten/);
	});
});
