import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeInspectionOutput, OUTPUT_CAP, parseWorktreePorcelainZ } from "./inspect_worktrees.ts";

const INSPECTOR = fileURLToPath(new URL("./inspect_worktrees.ts", import.meta.url));
const PLANNER = fileURLToPath(new URL("./plan_worktree.ts", import.meta.url));

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runNode(script: string, args: string[]): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn("node", [script, ...args], {
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

function git(cwd: string, args: string[]): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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

async function initRepo(root: string, branch = "main"): Promise<string> {
	const repo = join(root, "repo");
	mkdirSync(repo);
	assert.equal((await git(repo, ["init", "-q"])).code, 0);
	assert.equal((await git(repo, ["config", "user.name", "Test"])).code, 0);
	assert.equal((await git(repo, ["config", "user.email", "test@example.com"])).code, 0);
	writeFileSync(join(repo, "file.txt"), "base\n");
	assert.equal((await git(repo, ["add", "file.txt"])).code, 0);
	assert.equal((await git(repo, ["commit", "-qm", "init"])).code, 0);
	assert.equal((await git(repo, ["branch", "-M", branch])).code, 0);
	return repo;
}

describe("parseWorktreePorcelainZ", () => {
	it("parses a synthetic NUL record", () => {
		const data = Buffer.from(
			"worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /managed/x\0HEAD def\0branch refs/heads/kstack/x\0locked build\0\0",
		);
		assert.deepEqual(parseWorktreePorcelainZ(data), [
			{ worktree: "/repo", HEAD: "abc", branch: "refs/heads/main" },
			{ worktree: "/managed/x", HEAD: "def", branch: "refs/heads/kstack/x", locked: "build" },
		]);
	});
});

describe("inspect_worktrees CLI", () => {
	it("rejects out-of-range --max and --timeout", async () => {
		const max = await runNode(INSPECTOR, ["--max", "0"]);
		assert.equal(max.code, 2);
		assert.deepEqual(JSON.parse(max.stdout), { error: "--max must be between 1 and 1000" });
		const timeout = await runNode(INSPECTOR, ["--timeout", "61"]);
		assert.equal(timeout.code, 2);
		assert.deepEqual(JSON.parse(timeout.stdout), { error: "--timeout must be between 1 and 60" });
	});

	it("marks a symlink as an orphan without following it", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const managed = join(root, "managed");
		const namespace = join(managed, "repo-12345678");
		const outside = join(root, "outside");
		mkdirSync(namespace, { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(namespace, "escape"));
		const result = await runNode(INSPECTOR, ["--root", managed]);
		assert.equal(result.code, 0, result.stderr);
		const payload = JSON.parse(result.stdout) as {
			worktrees: unknown[];
			orphans: Array<{ reason: string }>;
		};
		assert.deepEqual(payload.worktrees, []);
		assert.match(payload.orphans[0]?.reason ?? "", /symlink/);
	});

	it("truncates listing at --max", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const managed = join(root, "managed");
		const namespace = join(managed, "repo-12345678");
		mkdirSync(join(namespace, "one"), { recursive: true });
		mkdirSync(join(namespace, "two"));
		const result = await runNode(INSPECTOR, ["--root", managed, "--max", "1"]);
		assert.equal(result.code, 0, result.stderr);
		const payload = JSON.parse(result.stdout) as {
			candidate_count: number;
			truncated: boolean;
			orphans: unknown[];
			worktrees: unknown[];
		};
		assert.equal(payload.candidate_count, 2);
		assert.equal(payload.truncated, true);
		assert.equal(payload.orphans.length + payload.worktrees.length, 1);
	});

	it("caps oversized output", () => {
		const encoded = encodeInspectionOutput({
			managed_root: "/managed",
			worktrees: [{ path: "x".repeat(OUTPUT_CAP) }],
			orphans: [],
			truncated: false,
			candidate_count: 1,
		});
		assert.equal(encoded.overflow, true);
		const payload = JSON.parse(encoded.body) as {
			error: string;
			truncated: boolean;
			candidate_count: number;
			managed_root: string;
		};
		assert.match(payload.error, /exceeded/);
		assert.equal(payload.truncated, true);
		assert.equal(payload.candidate_count, 1);
		assert.equal(payload.managed_root, "/managed");
	});

	it("inspects a dirty managed worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const repo = await initRepo(root);
		const managed = join(root, "managed");
		const planned = await runNode(PLANNER, ["--repo", repo, "--root", managed, "--task", "change"]);
		assert.equal(planned.code, 0, planned.stderr);
		const plan = JSON.parse(planned.stdout) as { branch: string; path: string; base_sha: string };
		assert.equal(plan.branch, "kstack/change");
		mkdirSync(dirname(plan.path), { recursive: true });
		assert.equal((await git(repo, ["worktree", "add", "-q", "-b", "kstack/change", plan.path, "HEAD"])).code, 0);
		writeFileSync(join(plan.path, "new.txt"), "untracked\n");
		const result = await runNode(INSPECTOR, ["--root", managed]);
		assert.equal(result.code, 0, result.stderr);
		const payload = JSON.parse(result.stdout) as {
			orphans: unknown[];
			worktrees: Array<{
				branch: string;
				dirty: boolean;
				untracked_entries: number;
			}>;
		};
		assert.deepEqual(payload.orphans, []);
		assert.equal(payload.worktrees.length, 1);
		assert.equal(payload.worktrees[0]?.branch, "kstack/change");
		assert.equal(payload.worktrees[0]?.dirty, true);
		assert.equal(payload.worktrees[0]?.untracked_entries, 1);
	});

	it("uses resolveIsolationBase when a worktree has no remote", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const repo = await initRepo(root, "topic");
		const managed = join(root, "managed");
		const planned = await runNode(PLANNER, ["--repo", repo, "--root", managed, "--task", "change"]);
		assert.equal(planned.code, 0, planned.stderr);
		const plan = JSON.parse(planned.stdout) as { path: string; base_ref: string };
		assert.equal(plan.base_ref, "HEAD");
		mkdirSync(dirname(plan.path), { recursive: true });
		assert.equal((await git(repo, ["worktree", "add", "-q", "-b", "kstack/change", plan.path, "HEAD"])).code, 0);
		const result = await runNode(INSPECTOR, ["--root", managed]);
		assert.equal(result.code, 0, result.stderr);
		const payload = JSON.parse(result.stdout) as {
			worktrees: Array<{ base_ref: string; base_sha: string }>;
		};
		assert.equal(payload.worktrees[0]?.base_ref, "HEAD");
		assert.equal(payload.worktrees[0]?.base_sha.length, 40);
	});
});
