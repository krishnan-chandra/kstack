import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { extractSlug } from "../../../extensions/shared/slug.ts";
import { createVcsTestEnv } from "../../../extensions/shared/vcs-test-env.ts";

const PLANNER = fileURLToPath(new URL("./plan_worktree.ts", import.meta.url));

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCli(args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn("node", [PLANNER, ...args], {
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

async function initRepo(root: string, env?: NodeJS.ProcessEnv): Promise<string> {
	const repo = join(root, "repo");
	mkdirSync(repo);
	assert.equal((await git(repo, ["init", "-q"], env)).code, 0);
	assert.equal((await git(repo, ["config", "user.name", "Test"], env)).code, 0);
	assert.equal((await git(repo, ["config", "user.email", "test@example.com"], env)).code, 0);
	writeFileSync(join(repo, "file.txt"), "base\n");
	assert.equal((await git(repo, ["add", "file.txt"], env)).code, 0);
	assert.equal((await git(repo, ["commit", "-qm", "init"], env)).code, 0);
	return repo;
}

describe("plan_worktree CLI", () => {
	it("requires --task", async () => {
		const result = await runCli([]);
		assert.equal(result.code, 2);
		assert.deepEqual(JSON.parse(result.stdout), { error: "missing --task" });
	});

	it("falls back to HEAD or local main in a repo with no remotes", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-plan-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, vcsEnv);
			const result = await runCli(
				["--repo", repo, "--root", join(root, "managed"), "--task", "Add archive search"],
				vcsEnv,
			);
			assert.equal(result.code, 0, result.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const plan = JSON.parse(result.stdout) as { base_ref: string; base_sha: string; branch: string; slug: string };
			assert.match(plan.base_ref, /^(HEAD|refs\/heads\/(main|master))$/);
			assert.equal(plan.base_sha.length, 40);
			assert.equal(plan.branch, "kstack/add-archive-search");
			assert.equal(plan.slug, extractSlug("Add archive search"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allocates a -2 slug when the first branch exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-plan-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, vcsEnv);
			const managed = join(root, "managed");
			const first = await runCli(["--repo", repo, "--root", managed, "--task", "change"], vcsEnv);
			assert.equal(first.code, 0, first.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const plan = JSON.parse(first.stdout) as { branch: string; path: string };
			assert.equal(plan.branch, "kstack/change");
			assert.equal((await git(repo, ["branch", "kstack/change"], vcsEnv)).code, 0);
			const second = await runCli(["--repo", repo, "--root", managed, "--task", "change"], vcsEnv);
			assert.equal(second.code, 0, second.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const next = JSON.parse(second.stdout) as { branch: string; slug: string };
			assert.equal(next.branch, "kstack/change-2");
			assert.equal(next.slug, "change-2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("places the destination under --root", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-plan-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, vcsEnv);
			const managed = join(root, "elsewhere");
			const result = await runCli(["--repo", repo, "--root", managed, "--task", "change"], vcsEnv);
			assert.equal(result.code, 0, result.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const plan = JSON.parse(result.stdout) as { managed_root: string; path: string };
			assert.equal(plan.managed_root, managed);
			assert.equal(dirname(dirname(plan.path)), managed);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a non-git directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-plan-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const result = await runCli(["--repo", root, "--task", "change"], vcsEnv);
			assert.equal(result.code, 2);
			assert.deepEqual(JSON.parse(result.stdout), { error: "Worktree mode requires a Git working tree." });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
