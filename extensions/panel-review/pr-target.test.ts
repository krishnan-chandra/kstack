import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { materializePrSnapshot, resolvePrTarget } from "./pr-target.ts";
import type { SnapshotGitSpawn } from "./snapshot-objects.ts";

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

function createRealExec(env?: NodeJS.ProcessEnv): ExecFn {
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

async function runOk(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const completed = await createRealExec(env)(command, args, { cwd, timeout: 10_000 });
	assert.equal(completed.code, 0, completed.stderr);
	return completed.stdout.trim();
}

function runBuffer(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv, input?: Buffer): Buffer {
	const completed = spawnSync(command, args, {
		cwd,
		env,
		input,
		timeout: 10_000,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	assert.equal(completed.status, 0, completed.stderr.toString("utf8") || completed.error?.message);
	return completed.stdout;
}

describe("resolvePrTarget", () => {
	it("resolves a pinned PR and fetches its head and base in one bounded call", async () => {
		const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
		const exec: ExecFn = async (command, args, options) => {
			calls.push({ command, args, timeout: options.timeout });
			if (command === "gh") return result(0, mockGhResponse());
			if (args.includes("check-ref-format")) return result(0);
			if (args.includes("fetch")) return result(0);
			if (args.includes("cat-file")) return result(0);
			if (args.includes("merge-base")) return result(0, `${MERGE_BASE_SHA}\n`);
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
		const catFiles = calls.filter((call) => call.command === "git" && call.args.includes("cat-file"));
		assert.equal(catFiles.length, 2);
		assert.ok(catFiles.every((call) => call.args[0] === "--no-replace-objects"));
		const mergeBases = calls.filter((call) => call.command === "git" && call.args.includes("merge-base"));
		assert.equal(mergeBases.length, 1);
		assert.equal(mergeBases[0].args[0], "--no-replace-objects");
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
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		const remote = join(root, "remote.git");
		const seed = join(root, "seed");
		const checkout = join(root, "checkout");
		try {
			mkdirSync(seed);
			await run(root, "git", ["init", "--bare", "-q", remote]);
			await run(seed, "git", ["init", "-q"]);
			await run(seed, "git", ["config", "user.email", "test@example.com"]);
			await run(seed, "git", ["config", "user.name", "Test"]);
			writeFileSync(join(seed, "base.txt"), "one\n");
			await run(seed, "git", ["add", "base.txt"]);
			await run(seed, "git", ["commit", "-qm", "base one"]);
			await run(seed, "git", ["branch", "-M", "main"]);
			await run(seed, "git", ["remote", "add", "origin", remote]);
			await run(seed, "git", ["push", "-q", "-u", "origin", "main"]);
			await run(root, "git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
			await run(root, "git", ["clone", "-q", remote, checkout]);
			const localMain = await run(checkout, "git", ["rev-parse", "main"]);

			writeFileSync(join(seed, "base.txt"), "two\n");
			await run(seed, "git", ["commit", "-qam", "base two"]);
			const baseSha = await run(seed, "git", ["rev-parse", "HEAD"]);
			await run(seed, "git", ["push", "-q", "origin", "main"]);
			await run(seed, "git", ["switch", "-qc", "feature"]);
			writeFileSync(join(seed, "feature.txt"), "feature\n");
			await run(seed, "git", ["add", "feature.txt"]);
			await run(seed, "git", ["commit", "-qm", "feature"]);
			const headSha = await run(seed, "git", ["rev-parse", "HEAD"]);
			await run(seed, "git", ["push", "-q", "origin", "HEAD:refs/pull/42/head"]);

			const refsBefore = await run(checkout, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]);
			const exec: ExecFn = (command, args, options) =>
				command === "gh"
					? Promise.resolve(result(0, mockGhResponse({ headRefOid: headSha, baseRefOid: baseSha })))
					: createRealExec(vcsEnv)(command, args, options);
			const target = await resolvePrTarget(exec, checkout, 42);

			assert.equal(target.headSha, headSha);
			assert.equal(await run(checkout, "git", ["rev-parse", "main"]), localMain);
			assert.equal(await run(checkout, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]), refsBefore);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a missing pinned head after fetch", async () => {
		const exec: ExecFn = async (command, args) => {
			if (command === "gh") return result(0, mockGhResponse());
			if (args.includes("check-ref-format") || args.includes("fetch")) return result(0);
			if (args.includes("cat-file") && args.includes(`${HEAD_SHA}^{commit}`)) return result(1);
			return result(0, MERGE_BASE_SHA);
		};
		await assert.rejects(resolvePrTarget(exec, "/repo", 42), /head commit.*was not found after fetch/);
	});
});

describe("materializePrSnapshot", () => {
	it("extracts the pinned commit without changing refs, worktrees, or dirty source files", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-source-"));
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
			writeFileSync(join(repo, "tracked.txt"), "committed\n");
			await run(repo, "git", ["add", "tracked.txt"]);
			await run(repo, "git", ["commit", "-qm", "initial"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			mkdirSync(join(repo, ".jj"));
			writeFileSync(join(repo, "tracked.txt"), "dirty\n");
			const refsBefore = await run(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]);
			const worktreesBefore = await run(repo, "git", ["worktree", "list", "--porcelain"]);

			const snapshot = await materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, { tmpDir: snapshots });
			snapshotRoot = snapshot.root;
			assert.equal(readFileSync(join(snapshot.directory, "tracked.txt"), "utf8"), "committed\n");
			assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "dirty\n");
			assert.equal(existsSync(join(snapshot.directory, ".git")), false);
			assert.equal(existsSync(join(snapshot.directory, ".gitconfig")), false);
			assert.equal(existsSync(join(snapshot.directory, ".jjconfig.toml")), false);
			assert.equal(await run(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]), refsBefore);
			assert.equal(await run(repo, "git", ["worktree", "list", "--porcelain"]), worktreesBefore);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("materializes exact pinned blob bytes despite export attributes", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-exact-blobs-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		const binaryPath = "nested/ignored.bin";
		const substitutedPath = "substituted.txt";
		const executablePath = "script.sh";
		const whitespacePath = "white space\nname.txt";
		let snapshotRoot: string | undefined;
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			mkdirSync(join(repo, "nested"));
			await run(repo, "git", ["init", "-q"]);
			writeFileSync(join(repo, ".gitattributes"), `${substitutedPath} export-subst\n`);
			writeFileSync(join(repo, "nested", ".gitattributes"), "ignored.bin export-ignore\n");
			writeFileSync(join(repo, binaryPath), Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x0a]));
			writeFileSync(join(repo, substitutedPath), "$Format:%H$\n");
			writeFileSync(join(repo, executablePath), "#!/bin/sh\nprintf exact\n");
			chmodSync(join(repo, executablePath), 0o755);
			writeFileSync(join(repo, whitespacePath), "spaced\n");
			symlinkSync(executablePath, join(repo, "contained-link"));
			await run(repo, "git", ["add", "."]);
			await run(repo, "git", ["commit", "-qm", "exact blob fixture"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			const refsBefore = await run(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]);
			const indexBefore = runBuffer(repo, "git", ["ls-files", "--stage", "-z"], vcsEnv);
			const statusBefore = runBuffer(repo, "git", ["status", "--porcelain=v1", "-z"], vcsEnv);
			const attributesBefore = readFileSync(join(repo, ".gitattributes"));
			const expected = new Map(
				[binaryPath, substitutedPath, executablePath, whitespacePath].map((path) => [
					path,
					runBuffer(repo, "git", ["cat-file", "blob", `${headSha}:${path}`], vcsEnv),
				]),
			);
			const processArgs: string[][] = [];
			const spawnImpl: SnapshotGitSpawn = (command, args, options) => {
				processArgs.push(args);
				return spawn(command, args, options);
			};

			const snapshot = await materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
				tmpDir: snapshots,
				objectProcess: { env: vcsEnv, spawn: spawnImpl },
			});
			snapshotRoot = snapshot.root;
			for (const [path, bytes] of expected) {
				assert.deepEqual(readFileSync(join(snapshot.directory, path)), bytes, path);
			}
			assert.notEqual(statSync(join(snapshot.directory, executablePath)).mode & 0o111, 0);
			assert.equal(readlinkSync(join(snapshot.directory, "contained-link")), executablePath);
			assert.equal(await run(repo, "git", ["for-each-ref", "--format=%(refname):%(objectname)"]), refsBefore);
			assert.deepEqual(runBuffer(repo, "git", ["ls-files", "--stage", "-z"], vcsEnv), indexBefore);
			assert.deepEqual(runBuffer(repo, "git", ["status", "--porcelain=v1", "-z"], vcsEnv), statusBefore);
			assert.deepEqual(readFileSync(join(repo, ".gitattributes")), attributesBefore);
			assert.equal(processArgs.filter((args) => args.includes("cat-file")).length, 1);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores replacement objects for tree metadata and blob reads", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-replace-object-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		let snapshotRoot: string | undefined;
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			writeFileSync(join(repo, "file"), "pinned bytes\n");
			await run(repo, "git", ["add", "file"]);
			await run(repo, "git", ["commit", "-qm", "pinned"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			const originalId = await run(repo, "git", ["rev-parse", `${headSha}:file`]);
			const replacementId = runBuffer(
				repo,
				"git",
				["hash-object", "-w", "--stdin"],
				vcsEnv,
				Buffer.from("replacement bytes are longer\n"),
			)
				.toString("ascii")
				.trim();
			await run(repo, "git", ["replace", originalId, replacementId]);
			const expected = runBuffer(repo, "git", ["--no-replace-objects", "cat-file", "blob", originalId], vcsEnv);

			const snapshot = await materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
				tmpDir: snapshots,
				objectProcess: { env: vcsEnv },
			});
			snapshotRoot = snapshot.root;
			assert.deepEqual(readFileSync(join(snapshot.directory, "file")), expected);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("materializes an empty pinned tree without starting a batch reader", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-empty-tree-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		const processArgs: string[][] = [];
		const spawnImpl: SnapshotGitSpawn = (command, args, options) => {
			processArgs.push(args);
			return spawn(command, args, options);
		};
		let snapshotRoot: string | undefined;
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			await run(repo, "git", ["commit", "--allow-empty", "-qm", "empty tree"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			const snapshot = await materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
				tmpDir: snapshots,
				objectProcess: { env: vcsEnv, spawn: spawnImpl },
			});
			snapshotRoot = snapshot.root;
			assert.deepEqual(readdirSync(snapshot.directory), []);
			assert.equal(processArgs.filter((args) => args.includes("cat-file")).length, 0);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an invalid UTF-8 tree path without creating a partial snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-invalid-name-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			const blobId = runBuffer(repo, "git", ["hash-object", "-w", "--stdin"], vcsEnv, Buffer.from("x"))
				.toString("ascii")
				.trim();
			const treeInput = Buffer.concat([Buffer.from(`100644 blob ${blobId}\t`, "ascii"), Buffer.from([0xff, 0x00])]);
			const treeId = runBuffer(repo, "git", ["mktree", "-z"], vcsEnv, treeInput).toString("ascii").trim();
			const commitId = runBuffer(repo, "git", ["commit-tree", treeId, "-m", "invalid name"], vcsEnv)
				.toString("ascii")
				.trim();
			await assert.rejects(
				materializePrSnapshot(createRealExec(vcsEnv), repo, commitId, {
					tmpDir: snapshots,
					objectProcess: { env: vcsEnv },
				}),
				/not valid UTF-8.*unsupported/,
			);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves and materializes distinct ordinary and U+FEFF-prefixed filenames", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-bom-"));
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		const remote = join(root, "remote.git");
		const seed = join(root, "seed");
		const checkout = join(root, "checkout");
		const snapshots = join(root, "snapshots");
		let snapshotRoot: string | undefined;
		try {
			mkdirSync(seed);
			mkdirSync(snapshots);
			await run(root, "git", ["init", "--bare", "-q", remote]);
			await run(seed, "git", ["init", "-q"]);
			await run(seed, "git", ["config", "user.email", "test@example.com"]);
			await run(seed, "git", ["config", "user.name", "Test"]);
			writeFileSync(join(seed, "base.txt"), "base\n");
			await run(seed, "git", ["add", "base.txt"]);
			await run(seed, "git", ["commit", "-qm", "base"]);
			await run(seed, "git", ["branch", "-M", "main"]);
			await run(seed, "git", ["remote", "add", "origin", remote]);
			await run(seed, "git", ["push", "-q", "-u", "origin", "main"]);
			await run(root, "git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
			await run(root, "git", ["clone", "-q", remote, checkout]);

			const ordinaryName = "file.txt";
			const bomName = "\uFEFFfile.txt";
			const lookalikeContextName = "\uFEFFAGENTS.md";
			writeFileSync(join(seed, ordinaryName), "ordinary content\n");
			writeFileSync(join(seed, bomName), "bom content\n");
			writeFileSync(join(seed, lookalikeContextName), "lookalike context content\n");
			await run(seed, "git", ["add", ordinaryName, bomName, lookalikeContextName]);
			await run(seed, "git", ["commit", "-qm", "add distinct files"]);
			const headSha = await run(seed, "git", ["rev-parse", "HEAD"]);
			const baseSha = await run(seed, "git", ["rev-parse", "main"]);
			await run(seed, "git", ["push", "-q", "origin", "HEAD:refs/pull/42/head"]);

			const exec: ExecFn = (command, args, options) =>
				command === "gh"
					? Promise.resolve(result(0, mockGhResponse({ headRefOid: headSha, baseRefOid: baseSha })))
					: createRealExec(vcsEnv)(command, args, options);

			const target = await resolvePrTarget(exec, checkout, 42);
			assert.equal(target.headSha, headSha);

			const snapshot = await materializePrSnapshot(exec, checkout, target.headSha, {
				tmpDir: snapshots,
				objectProcess: { env: vcsEnv },
			});
			snapshotRoot = snapshot.root;

			const materializedOrdinary = join(snapshot.directory, ordinaryName);
			const materializedBom = join(snapshot.directory, bomName);
			const materializedLookalike = join(snapshot.directory, lookalikeContextName);
			assert.equal(existsSync(materializedOrdinary), true);
			assert.equal(existsSync(materializedBom), true);
			assert.equal(existsSync(materializedLookalike), true);
			assert.equal(readFileSync(materializedOrdinary, "utf8"), "ordinary content\n");
			assert.equal(readFileSync(materializedBom, "utf8"), "bom content\n");
			assert.equal(readFileSync(materializedLookalike, "utf8"), "lookalike context content\n");
			assert.equal(existsSync(join(snapshot.directory, "AGENTS.md")), false);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("materializes repository-contained symlinks", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-contained-symlink-"));
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
			mkdirSync(join(repo, "nested"));
			mkdirSync(join(repo, "resources"));
			writeFileSync(join(repo, "AGENTS.md"), "instructions\n");
			writeFileSync(join(repo, "resources", "udd.json"), "{}\n");
			symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
			symlinkSync("CLAUDE.md", join(repo, "INSTRUCTIONS.md"));
			symlinkSync("../resources/udd.json", join(repo, "nested", "udd.json"));
			// A chain that passes through the same directory link twice is not a cycle.
			mkdirSync(join(repo, "resources", "inner"));
			writeFileSync(join(repo, "resources", "inner", "keep"), "");
			symlinkSync("resources", join(repo, "current"));
			symlinkSync("../current/inner", join(repo, "resources", "alias"));
			symlinkSync("current/alias/../udd.json", join(repo, "diamond.json"));
			await run(repo, "git", ["add", "."]);
			await run(repo, "git", ["commit", "-qm", "add contained symlinks"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);

			const snapshot = await materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, { tmpDir: snapshots });
			snapshotRoot = snapshot.root;
			assert.equal(readlinkSync(join(snapshot.directory, "CLAUDE.md")), "AGENTS.md");
			assert.equal(readFileSync(join(snapshot.directory, "CLAUDE.md"), "utf8"), "instructions\n");
			assert.equal(readlinkSync(join(snapshot.directory, "INSTRUCTIONS.md")), "CLAUDE.md");
			assert.equal(readFileSync(join(snapshot.directory, "INSTRUCTIONS.md"), "utf8"), "instructions\n");
			assert.equal(readlinkSync(join(snapshot.directory, "nested", "udd.json")), "../resources/udd.json");
			assert.equal(readFileSync(join(snapshot.directory, "nested", "udd.json"), "utf8"), "{}\n");
			assert.equal(readFileSync(join(snapshot.directory, "diamond.json"), "utf8"), "{}\n");
			assert.equal(existsSync(join(snapshot.directory, ".gitconfig")), false);
			assert.equal(existsSync(join(snapshot.directory, ".jjconfig.toml")), false);
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects absolute, parent-relative, and dangling symlinks and removes the snapshot", async () => {
		const cases: Array<[string, RegExp]> = [
			["/etc/passwd", /symlink "review-target" escapes the snapshot root/],
			["..", /symlink "review-target" escapes the snapshot root/],
			["dist/generated.json", /symlink "review-target" does not resolve to a snapshot file/],
		];
		for (const [linkTarget, expected] of cases) {
			const root = mkdtempSync(join(tmpdir(), "panel-pr-symlink-"));
			const repo = join(root, "repo");
			const snapshots = join(root, "snapshots");
			const vcsEnv = createVcsTestEnv(root);
			const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
			try {
				mkdirSync(repo);
				mkdirSync(snapshots);
				await run(repo, "git", ["init", "-q"]);
				await run(repo, "git", ["config", "user.email", "test@example.com"]);
				await run(repo, "git", ["config", "user.name", "Test"]);
				symlinkSync(linkTarget, join(repo, "review-target"));
				await run(repo, "git", ["add", "review-target"]);
				await run(repo, "git", ["commit", "-qm", "add symlink"]);
				const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);

				await assert.rejects(
					materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, { tmpDir: snapshots }),
					expected,
				);
				assert.deepEqual(readdirSync(snapshots), []);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("rejects escaping symlink chains and cycles and removes the snapshot", async () => {
		for (const fixture of ["escape-chain", "cycle"] as const) {
			const root = mkdtempSync(join(tmpdir(), `panel-pr-${fixture}-`));
			const repo = join(root, "repo");
			const snapshots = join(root, "snapshots");
			const vcsEnv = createVcsTestEnv(root);
			const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
			try {
				mkdirSync(repo);
				mkdirSync(snapshots);
				await run(repo, "git", ["init", "-q"]);
				await run(repo, "git", ["config", "user.email", "test@example.com"]);
				await run(repo, "git", ["config", "user.name", "Test"]);
				if (fixture === "escape-chain") {
					mkdirSync(join(repo, "nested"));
					symlinkSync("..", join(repo, "nested", "dirlink"));
					symlinkSync("nested/dirlink/../..", join(repo, "entry"));
				} else {
					symlinkSync("second", join(repo, "first"));
					symlinkSync("first", join(repo, "second"));
				}
				await run(repo, "git", ["add", "."]);
				await run(repo, "git", ["commit", "-qm", `add ${fixture}`]);
				const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);

				await assert.rejects(
					materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, { tmpDir: snapshots }),
					fixture === "cycle" ? /contains a cycle/ : /escapes the snapshot root/,
				);
				assert.deepEqual(readdirSync(snapshots), []);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("rejects tracked-byte and entry limits before opening the batch reader", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-limits-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		let batchCalled = false;
		const spawnImpl: SnapshotGitSpawn = (command, args, options) => {
			if (args.includes("cat-file")) batchCalled = true;
			return spawn(command, args, options);
		};
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			writeFileSync(join(repo, "first"), "123456789");
			writeFileSync(join(repo, "second"), "x");
			await run(repo, "git", ["add", "."]);
			await run(repo, "git", ["commit", "-qm", "limits"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			const objectProcess = { env: vcsEnv, spawn: spawnImpl };

			await assert.rejects(
				materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
					tmpDir: snapshots,
					maxBlobBytes: 9,
					objectProcess,
				}),
				/tracked blob bytes \(10\) exceeds the limit \(9\)/,
			);
			await assert.rejects(
				materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
					tmpDir: snapshots,
					maxTrackedEntries: 1,
					objectProcess,
				}),
				/tracked entries \(2\) exceeds the limit \(1\)/,
			);
			assert.equal(batchCalled, false);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("counts gitlinks as tracked entries without requiring a blob size", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-gitlink-limit-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		let batchCalled = false;
		const spawnImpl: SnapshotGitSpawn = (command, args, options) => {
			if (args.includes("cat-file")) batchCalled = true;
			return spawn(command, args, options);
		};
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			writeFileSync(join(repo, "file"), "x");
			await run(repo, "git", ["add", "file"]);
			await run(repo, "git", ["commit", "-qm", "base"]);
			const gitlinkSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await run(repo, "git", ["update-index", "--add", "--cacheinfo", `160000,${gitlinkSha},submodule`]);
			await run(repo, "git", ["commit", "-qm", "gitlink"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);

			await assert.rejects(
				materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
					tmpDir: snapshots,
					maxTrackedEntries: 1,
					objectProcess: { env: vcsEnv, spawn: spawnImpl },
				}),
				/tracked entries \(2\) exceeds the limit \(1\)/,
			);
			assert.equal(batchCalled, false);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects the tree-metadata limit before creating a snapshot root", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-metadata-limit-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			writeFileSync(join(repo, "file"), "x");
			await run(repo, "git", ["add", "file"]);
			await run(repo, "git", ["commit", "-qm", "metadata"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await assert.rejects(
				materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
					tmpDir: snapshots,
					maxTreeMetadataBytes: 1,
					objectProcess: { env: vcsEnv },
				}),
				/tree metadata .* exceeds the limit \(1\)/,
			);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("propagates a batch-read abort and removes the partial snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-aborted-snapshot-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		const controller = new AbortController();
		const spawnImpl: SnapshotGitSpawn = (command, args, options) => {
			const child = spawn(command, args, options);
			if (args.includes("cat-file")) controller.abort();
			return child;
		};
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			writeFileSync(join(repo, "file"), Buffer.alloc(1024, 0x61));
			await run(repo, "git", ["add", "file"]);
			await run(repo, "git", ["commit", "-qm", "abort"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await assert.rejects(
				materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
					tmpDir: snapshots,
					signal: controller.signal,
					objectProcess: { env: vcsEnv, spawn: spawnImpl },
				}),
				/aborted/,
			);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes its temporary directory when object transport fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-pr-failed-snapshot-"));
		const repo = join(root, "repo");
		const snapshots = join(root, "snapshots");
		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => runOk(cwd, command, args, vcsEnv);
		const spawnImpl: SnapshotGitSpawn = (command, args, options) => {
			if (!args.includes("cat-file")) return spawn(command, args, options);
			const invalidArgs = args.slice(0, args.indexOf("cat-file") + 1).concat("--definitely-invalid");
			return spawn(command, invalidArgs, options);
		};
		try {
			mkdirSync(repo);
			mkdirSync(snapshots);
			await run(repo, "git", ["init", "-q"]);
			writeFileSync(join(repo, "file"), "content");
			await run(repo, "git", ["add", "file"]);
			await run(repo, "git", ["commit", "-qm", "transport"]);
			const headSha = await run(repo, "git", ["rev-parse", "HEAD"]);
			await assert.rejects(
				materializePrSnapshot(createRealExec(vcsEnv), repo, headSha, {
					tmpDir: snapshots,
					objectProcess: { env: vcsEnv, spawn: spawnImpl },
				}),
				/batch output ended|Git process failed|EPIPE/,
			);
			assert.deepEqual(readdirSync(snapshots), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
