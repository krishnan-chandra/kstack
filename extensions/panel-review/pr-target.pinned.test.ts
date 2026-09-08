import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { materializePrSnapshot, resolvePrTarget } from "./pr-target.ts";
import { collectScope, type GitExec } from "./review-scope.ts";
import { buildIntentPrefill } from "./review-target.ts";

interface MockGhPrFields {
	headRefOid?: string;
	baseRefOid?: string;
}

function mockGhResponse(overrides: MockGhPrFields): string {
	return JSON.stringify({
		number: 42,
		url: "https://github.com/owner/repo/pull/42",
		title: "Add feature X",
		state: "OPEN",
		baseRefName: "main",
		...overrides,
	});
}

function result(code: number, stdout = "", stderr = ""): ExecFnResult {
	return { code, stdout, stderr };
}

function createRealExec(env: NodeJS.ProcessEnv): ExecFn {
	return (command, args, options) => {
		const completed = spawnSync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			env,
			timeout: options.timeout,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return Promise.resolve({
			code: completed.status ?? 1,
			stdout: completed.stdout,
			stderr: completed.stderr || completed.error?.message || "",
		});
	};
}

async function runOk(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	const completed = await createRealExec(env)(command, args, { cwd, timeout: 10_000 });
	assert.equal(completed.code, 0, completed.stderr);
	return completed.stdout.trim();
}

describe("pinned PR replacement objects", () => {
	it("preserves replacement refs while using immutable object reads for scope and materialization", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-replace-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		let snapshotRoot: string | undefined;
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			await run(repo, "git", ["config", "user.email", "test@example.com"]);
			await run(repo, "git", ["config", "user.name", "Test"]);
			await run(repo, "git", ["remote", "add", "origin", repo]);
			writeFileSync(join(repo, "base.txt"), "base\n");
			await run(repo, "git", ["add", "base.txt"]);
			await run(repo, "git", ["commit", "-qm", "base"]);
			await run(repo, "git", ["branch", "-M", "main"]);
			const baseSha = await run(repo, "git", ["rev-parse", "HEAD"]);

			writeFileSync(join(repo, "changed.txt"), "feature\n");
			await run(repo, "git", ["add", "changed.txt"]);
			await run(repo, "git", ["commit", "-qm", "changed"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await run(repo, "git", ["update-ref", "refs/pull/42/head", headSha]);

			await run(repo, "git", ["replace", headSha, baseSha]);
			const replaceRefBefore = await run(repo, "git", [
				"for-each-ref",
				"--format=%(refname):%(objectname)",
				"refs/replace/*",
			]);
			assert.ok(replaceRefBefore.length > 0);

			const realExec = createRealExec(vcsEnv);
			const exec: ExecFn = (command, args, options) =>
				command === "gh"
					? Promise.resolve(result(0, mockGhResponse({ headRefOid: headSha, baseRefOid: baseSha })))
					: realExec(command, args, options);

			const target = await resolvePrTarget(exec, repo, 42);
			const realGitExec: GitExec = (args, cwd) => {
				const completed = spawnSync("git", args, { cwd, encoding: "utf8", env: vcsEnv });
				assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
				return completed.stdout;
			};

			const scope = collectScope(
				repo,
				{ ref: target.baseRefName, mergeBaseSha: target.mergeBaseSha, strategy: "pr" },
				"Test PR",
				{ exec: realGitExec, headSha: target.headSha },
			);

			const snapshot = await materializePrSnapshot(exec, repo, target.headSha, {
				tmpDir: snapshots,
				objectProcess: { env: vcsEnv },
			});
			snapshotRoot = snapshot.root;

			assert.ok(scope.changedPaths.includes("changed.txt"));
			assert.equal(scope.fileCount, 1);
			assert.equal(readFileSync(join(snapshot.directory, "changed.txt"), "utf8"), "feature\n");

			const prefill = buildIntentPrefill(
				{
					kind: "pr",
					base: { ref: target.baseRefName, mergeBaseSha: target.mergeBaseSha, strategy: "pr" },
					pr: target,
				},
				realGitExec,
				repo,
			);
			assert.match(prefill, /changed/);

			const replaceRefAfter = await run(repo, "git", [
				"for-each-ref",
				"--format=%(refname):%(objectname)",
				"refs/replace/*",
			]);
			assert.equal(replaceRefAfter, replaceRefBefore);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores replacement refs that invent scope-only changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-invent-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		let snapshotRoot: string | undefined;
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			await run(repo, "git", ["config", "user.email", "test@example.com"]);
			await run(repo, "git", ["config", "user.name", "Test"]);
			await run(repo, "git", ["remote", "add", "origin", repo]);
			writeFileSync(join(repo, "base.txt"), "base\n");
			await run(repo, "git", ["add", "base.txt"]);
			await run(repo, "git", ["commit", "-qm", "base"]);
			await run(repo, "git", ["branch", "-M", "main"]);
			const baseSha = await run(repo, "git", ["rev-parse", "HEAD"]);

			writeFileSync(join(repo, "real.txt"), "real\n");
			await run(repo, "git", ["add", "real.txt"]);
			await run(repo, "git", ["commit", "-qm", "real change"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await run(repo, "git", ["update-ref", "refs/pull/42/head", headSha]);

			// Create a branch with an invented file
			await run(repo, "git", ["switch", "-c", "invented", baseSha]);
			writeFileSync(join(repo, "real.txt"), "real\n");
			writeFileSync(join(repo, "invented.txt"), "fake\n");
			await run(repo, "git", ["add", "real.txt", "invented.txt"]);
			await run(repo, "git", ["commit", "-qm", "invented changes"]);
			const inventedSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await run(repo, "git", ["switch", "-q", "main"]);

			// Replace headSha with inventedSha
			await run(repo, "git", ["replace", headSha, inventedSha]);
			const replaceRefBefore = await run(repo, "git", [
				"for-each-ref",
				"--format=%(refname):%(objectname)",
				"refs/replace/*",
			]);

			const realExec = createRealExec(vcsEnv);
			const exec: ExecFn = (command, args, options) =>
				command === "gh"
					? Promise.resolve(result(0, mockGhResponse({ headRefOid: headSha, baseRefOid: baseSha })))
					: realExec(command, args, options);

			const target = await resolvePrTarget(exec, repo, 42);
			const realGitExec: GitExec = (args, cwd) => {
				const completed = spawnSync("git", args, { cwd, encoding: "utf8", env: vcsEnv });
				assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
				return completed.stdout;
			};

			const scope = collectScope(
				repo,
				{ ref: target.baseRefName, mergeBaseSha: target.mergeBaseSha, strategy: "pr" },
				"Test PR",
				{ exec: realGitExec, headSha: target.headSha },
			);

			const snapshot = await materializePrSnapshot(exec, repo, target.headSha, {
				tmpDir: snapshots,
				objectProcess: { env: vcsEnv },
			});
			snapshotRoot = snapshot.root;

			// Scope reflects real objects, not invented replacement
			assert.deepEqual(scope.changedPaths, ["real.txt"]);
			assert.equal(scope.fileCount, 1);
			assert.equal(existsSync(join(snapshot.directory, "real.txt")), true);
			assert.equal(existsSync(join(snapshot.directory, "invented.txt")), false);

			const replaceRefAfter = await run(repo, "git", [
				"for-each-ref",
				"--format=%(refname):%(objectname)",
				"refs/replace/*",
			]);
			assert.equal(replaceRefAfter, replaceRefBefore);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves unreplaced objects when replacement affects the base commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-base-replace-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		let snapshotRoot: string | undefined;
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			await run(repo, "git", ["config", "user.email", "test@example.com"]);
			await run(repo, "git", ["config", "user.name", "Test"]);
			await run(repo, "git", ["remote", "add", "origin", repo]);
			writeFileSync(join(repo, "root.txt"), "root\n");
			await run(repo, "git", ["add", "root.txt"]);
			await run(repo, "git", ["commit", "-qm", "root commit"]);
			const rootSha = await run(repo, "git", ["rev-parse", "HEAD"]);

			writeFileSync(join(repo, "base-file.txt"), "base\n");
			await run(repo, "git", ["add", "base-file.txt"]);
			await run(repo, "git", ["commit", "-qm", "base commit"]);
			await run(repo, "git", ["branch", "-M", "main"]);
			const baseSha = await run(repo, "git", ["rev-parse", "HEAD"]);

			writeFileSync(join(repo, "pr-file.txt"), "pr\n");
			await run(repo, "git", ["add", "pr-file.txt"]);
			await run(repo, "git", ["commit", "-qm", "pr commit"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await run(repo, "git", ["update-ref", "refs/pull/42/head", headSha]);

			// Replace baseSha with rootSha
			await run(repo, "git", ["replace", baseSha, rootSha]);
			const replaceRefBefore = await run(repo, "git", [
				"for-each-ref",
				"--format=%(refname):%(objectname)",
				"refs/replace/*",
			]);

			const realExec = createRealExec(vcsEnv);
			const exec: ExecFn = (command, args, options) =>
				command === "gh"
					? Promise.resolve(result(0, mockGhResponse({ headRefOid: headSha, baseRefOid: baseSha })))
					: realExec(command, args, options);

			const target = await resolvePrTarget(exec, repo, 42);
			assert.equal(target.mergeBaseSha, baseSha);

			const realGitExec: GitExec = (args, cwd) => {
				const completed = spawnSync("git", args, { cwd, encoding: "utf8", env: vcsEnv });
				assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
				return completed.stdout;
			};

			const scope = collectScope(
				repo,
				{ ref: target.baseRefName, mergeBaseSha: target.mergeBaseSha, strategy: "pr" },
				"Test PR",
				{ exec: realGitExec, headSha: target.headSha },
			);

			const snapshot = await materializePrSnapshot(exec, repo, target.headSha, {
				tmpDir: snapshots,
				objectProcess: { env: vcsEnv },
			});
			snapshotRoot = snapshot.root;

			// Scope and diff only contain PR changes against base, not base-file.txt
			assert.deepEqual(scope.changedPaths, ["pr-file.txt"]);
			assert.equal(scope.fileCount, 1);
			assert.equal(readFileSync(join(snapshot.directory, "pr-file.txt"), "utf8"), "pr\n");

			const prefill = buildIntentPrefill(
				{
					kind: "pr",
					base: { ref: target.baseRefName, mergeBaseSha: target.mergeBaseSha, strategy: "pr" },
					pr: target,
				},
				realGitExec,
				repo,
			);
			assert.match(prefill, /pr commit/);
			assert.doesNotMatch(prefill, /base commit/);

			const replaceRefAfter = await run(repo, "git", [
				"for-each-ref",
				"--format=%(refname):%(objectname)",
				"refs/replace/*",
			]);
			assert.equal(replaceRefAfter, replaceRefBefore);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});
