import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { materializePrSnapshot, resolvePrTarget } from "./pr-target.ts";

const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "2222222222222222222222222222222222222222";
const MERGE_BASE_SHA = "3333333333333333333333333333333333333333";

interface MockGhPrFields {
	number?: number;
	url?: string;
	title?: string;
	state?: string;
	headRefOid?: string;
	baseRefName?: string;
	baseRefOid?: string;
}

function mockGhResponse(overrides: MockGhPrFields = {}) {
	return JSON.stringify({
		number: 42,
		url: "https://github.com/owner/repo/pull/42",
		title: "Add feature X",
		state: "OPEN",
		headRefOid: HEAD_SHA,
		baseRefName: "main",
		baseRefOid: BASE_SHA,
		...overrides,
	});
}

function result(code: number, stdout = "", stderr = ""): ExecFnResult {
	return { code, stdout, stderr };
}

function realExec(command: string, args: string[], options: { cwd: string; timeout?: number }): Promise<ExecFnResult> {
	const completed = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		timeout: options.timeout,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return Promise.resolve({
		code: completed.status ?? 1,
		stdout: completed.stdout,
		stderr: completed.stderr || completed.error?.message || "",
	});
}

async function runOk(cwd: string, command: string, args: string[]): Promise<string> {
	const completed = await realExec(command, args, { cwd, timeout: 10_000 });
	assert.equal(completed.code, 0, completed.stderr);
	return completed.stdout.trim();
}

describe("resolvePrTarget", () => {
	it("resolves a pinned PR and fetches its head and base in one bounded call", async () => {
		const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
		const exec: ExecFn = async (command, args, options) => {
			calls.push({ command, args, timeout: options.timeout });
			if (command === "gh") return result(0, mockGhResponse());
			if (args[0] === "check-ref-format") return result(0);
			if (args[0] === "fetch") return result(0);
			if (args[0] === "cat-file") return result(0);
			if (args[0] === "merge-base") return result(0, `${MERGE_BASE_SHA}\n`);
			return result(1, "", `Unexpected command: ${command} ${args.join(" ")}`);
		};

		const target = await resolvePrTarget(exec, "/repo", 42);
		assert.deepEqual(target, {
			number: 42,
			url: "https://github.com/owner/repo/pull/42",
			title: "Add feature X",
			state: "OPEN",
			headSha: HEAD_SHA,
			baseRefName: "main",
			mergeBaseSha: MERGE_BASE_SHA,
		});
		const fetches = calls.filter((call) => call.command === "git" && call.args[0] === "fetch");
		assert.deepEqual(fetches, [
			{
				command: "git",
				args: [
					"fetch",
					"--no-tags",
					"--no-write-fetch-head",
					"--refmap=",
					"origin",
					"refs/pull/42/head",
					"refs/heads/main",
				],
				timeout: 60_000,
			},
		]);
	});

	it("rejects malformed or mismatched GitHub responses before fetching", async () => {
		for (const stdout of ["not json", mockGhResponse({ number: 43 })]) {
			const calls: string[][] = [];
			const exec: ExecFn = async (_command, args) => {
				calls.push(args);
				return result(0, stdout);
			};
			await assert.rejects(resolvePrTarget(exec, "/repo", 42), /invalid JSON|failed validation/);
			assert.ok(!calls.some((args) => args[0] === "fetch"));
		}
	});

	it("lets Git reject a hostile base ref before fetching", async () => {
		const calls: string[][] = [];
		const exec: ExecFn = async (command, args) => {
			calls.push(args);
			if (command === "gh") return result(0, mockGhResponse({ baseRefName: "../evil/ref" }));
			if (args[0] === "check-ref-format") return result(1, "", "fatal: invalid branch name");
			return result(0);
		};

		await assert.rejects(resolvePrTarget(exec, "/repo", 42), /not a valid Git branch name/);
		assert.ok(!calls.some((args) => args[0] === "fetch"));
	});

	it("fetches a checked-out base without moving local refs", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-fetch-"));
		const remote = join(root, "remote.git");
		const seed = join(root, "seed");
		const checkout = join(root, "checkout");
		try {
			mkdirSync(seed);
			await runOk(root, "git", ["init", "--bare", "-q", remote]);
			await runOk(seed, "git", ["init", "-q"]);
			await runOk(seed, "git", ["config", "user.email", "test@example.com"]);
			await runOk(seed, "git", ["config", "user.name", "Test"]);
			writeFileSync(join(seed, "base.txt"), "one\n");
			await runOk(seed, "git", ["add", "base.txt"]);
			await runOk(seed, "git", ["commit", "-qm", "base one"]);
			await runOk(seed, "git", ["branch", "-M", "main"]);
			await runOk(seed, "git", ["remote", "add", "origin", remote]);
			await runOk(seed, "git", ["push", "-q", "-u", "origin", "main"]);
			await runOk(root, "git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
			await runOk(root, "git", ["clone", "-q", remote, checkout]);
			const localMain = await runOk(checkout, "git", ["rev-parse", "main"]);

			writeFileSync(join(seed, "base.txt"), "two\n");
			await runOk(seed, "git", ["commit", "-qam", "base two"]);
			const baseSha = await runOk(seed, "git", ["rev-parse", "HEAD"]);
			await runOk(seed, "git", ["push", "-q", "origin", "main"]);
			await runOk(seed, "git", ["switch", "-qc", "feature"]);
			writeFileSync(join(seed, "feature.txt"), "feature\n");
			await runOk(seed, "git", ["add", "feature.txt"]);
			await runOk(seed, "git", ["commit", "-qm", "feature"]);
			const headSha = await runOk(seed, "git", ["rev-parse", "HEAD"]);
			await runOk(seed, "git", ["push", "-q", "origin", "HEAD:refs/pull/42/head"]);

			const refsBefore = await runOk(checkout, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]);
			const exec: ExecFn = (command, args, options) =>
				command === "gh"
					? Promise.resolve(result(0, mockGhResponse({ headRefOid: headSha, baseRefOid: baseSha })))
					: realExec(command, args, options);
			const target = await resolvePrTarget(exec, checkout, 42);

			assert.equal(target.headSha, headSha);
			assert.equal(await runOk(checkout, "git", ["rev-parse", "main"]), localMain);
			assert.equal(await runOk(checkout, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]), refsBefore);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a missing pinned head after fetch", async () => {
		const exec: ExecFn = async (command, args) => {
			if (command === "gh") return result(0, mockGhResponse());
			if (args[0] === "check-ref-format" || args[0] === "fetch") return result(0);
			if (args[0] === "cat-file" && args[2] === `${HEAD_SHA}^{commit}`) return result(1);
			return result(0, MERGE_BASE_SHA);
		};
		await assert.rejects(resolvePrTarget(exec, "/repo", 42), /head commit.*was not found after fetch/);
	});
});

describe("materializePrSnapshot", () => {
	it("extracts the pinned commit without changing refs, worktrees, or dirty source files", async () => {
		const repo = mkdtempSync(join(tmpdir(), "panel-pr-source-"));
		const snapshots = mkdtempSync(join(tmpdir(), "panel-pr-snapshots-"));
		let snapshotRoot: string | undefined;
		try {
			await runOk(repo, "git", ["init", "-q"]);
			await runOk(repo, "git", ["config", "user.email", "test@example.com"]);
			await runOk(repo, "git", ["config", "user.name", "Test"]);
			writeFileSync(join(repo, "tracked.txt"), "committed\n");
			await runOk(repo, "git", ["add", "tracked.txt"]);
			await runOk(repo, "git", ["commit", "-qm", "initial"]);
			const headSha = await runOk(repo, "git", ["rev-parse", "HEAD"]);
			mkdirSync(join(repo, ".jj"));
			writeFileSync(join(repo, "tracked.txt"), "dirty\n");
			const refsBefore = await runOk(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]);
			const worktreesBefore = await runOk(repo, "git", ["worktree", "list", "--porcelain"]);

			const snapshot = await materializePrSnapshot(realExec, repo, headSha, { tmpDir: snapshots });
			snapshotRoot = snapshot.root;
			assert.equal(readFileSync(join(snapshot.directory, "tracked.txt"), "utf8"), "committed\n");
			assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "dirty\n");
			assert.equal(existsSync(join(snapshot.directory, ".git")), false);
			assert.equal(await runOk(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]), refsBefore);
			assert.equal(await runOk(repo, "git", ["worktree", "list", "--porcelain"]), worktreesBefore);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(repo, { recursive: true, force: true });
			rmSync(snapshots, { recursive: true, force: true });
		}
	});

	it("rejects absolute and parent-relative symlinks before archiving", async () => {
		for (const linkTarget of ["/etc/passwd", "../../outside"]) {
			const repo = mkdtempSync(join(tmpdir(), "panel-pr-symlink-source-"));
			const snapshots = mkdtempSync(join(tmpdir(), "panel-pr-symlink-snapshots-"));
			try {
				await runOk(repo, "git", ["init", "-q"]);
				await runOk(repo, "git", ["config", "user.email", "test@example.com"]);
				await runOk(repo, "git", ["config", "user.name", "Test"]);
				symlinkSync(linkTarget, join(repo, "review-target"));
				await runOk(repo, "git", ["add", "review-target"]);
				await runOk(repo, "git", ["commit", "-qm", "add symlink"]);
				const headSha = await runOk(repo, "git", ["rev-parse", "HEAD"]);

				await assert.rejects(materializePrSnapshot(realExec, repo, headSha, { tmpDir: snapshots }), /symbolic links/);
				assert.deepEqual(readdirSync(snapshots), []);
			} finally {
				rmSync(repo, { recursive: true, force: true });
				rmSync(snapshots, { recursive: true, force: true });
			}
		}
	});

	it("rejects a tree that exceeds the tracked-byte or entry limit before archiving", async () => {
		let archiveCalled = false;
		const exec: ExecFn = async (_command, args) => {
			if (args[0] === "ls-tree") return result(0, "100644 blob 9\n100644 blob 1\n");
			archiveCalled = true;
			return result(0);
		};
		await assert.rejects(
			materializePrSnapshot(exec, "/repo", HEAD_SHA, { maxBlobBytes: 9, maxTrackedEntries: 1 }),
			/tracked blob bytes \(10\) exceeds the limit \(9\)/,
		);
		assert.equal(archiveCalled, false);
	});

	it("counts gitlinks as tracked entries without requiring a blob size", async () => {
		let archiveCalled = false;
		const exec: ExecFn = async (_command, args) => {
			if (args[0] === "ls-tree") return result(0, "100644 blob 1\n160000 commit -\n");
			archiveCalled = true;
			return result(0);
		};
		await assert.rejects(
			materializePrSnapshot(exec, "/repo", HEAD_SHA, { maxTrackedEntries: 1 }),
			/tracked entries \(2\) exceeds the limit \(1\)/,
		);
		assert.equal(archiveCalled, false);
	});

	it("rejects and removes an oversized archive before extraction", async () => {
		const snapshots = mkdtempSync(join(tmpdir(), "panel-pr-oversized-snapshot-"));
		let tarCalled = false;
		try {
			const exec: ExecFn = async (command, args) => {
				if (command === "git" && args[0] === "ls-tree") return result(0, "100644 blob 9\n");
				if (command === "git") {
					const outputArg = args.find((arg) => arg.startsWith("--output="));
					assert.ok(outputArg);
					writeFileSync(outputArg.slice("--output=".length), "too large");
					return result(0);
				}
				tarCalled = true;
				return result(0);
			};
			await assert.rejects(
				materializePrSnapshot(exec, "/repo", HEAD_SHA, { tmpDir: snapshots, maxArchiveBytes: 1 }),
				/archive bytes \(9\) exceeds the limit \(1\)/,
			);
			assert.equal(tarCalled, false);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(snapshots, { recursive: true, force: true });
		}
	});

	it("propagates an execution abort and removes the partial snapshot", async () => {
		const snapshots = mkdtempSync(join(tmpdir(), "panel-pr-aborted-snapshot-"));
		try {
			const controller = new AbortController();
			const exec: ExecFn = async (_command, args, options) => {
				assert.equal(options.signal, controller.signal);
				if (args[0] === "ls-tree") return result(0, "100644 blob 9\n");
				throw new Error("cancelled by signal");
			};
			await assert.rejects(
				materializePrSnapshot(exec, "/repo", HEAD_SHA, { tmpDir: snapshots, signal: controller.signal }),
				/cancelled by signal/,
			);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(snapshots, { recursive: true, force: true });
		}
	});

	it("removes its temporary directory when archive creation fails", async () => {
		const snapshots = mkdtempSync(join(tmpdir(), "panel-pr-failed-snapshot-"));
		try {
			const exec: ExecFn = async (_command, args) =>
				args[0] === "ls-tree" ? result(0, "100644 blob 9\n") : result(1, "", "archive failed");
			await assert.rejects(materializePrSnapshot(exec, "/repo", HEAD_SHA, { tmpDir: snapshots }), /archive failed/);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(snapshots, { recursive: true, force: true });
		}
	});
});
