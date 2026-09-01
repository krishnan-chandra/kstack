import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { createGitStoreExec, resolveJjReviewTarget } from "./jj-target.ts";
import { materializePrSnapshot } from "./pr-target.ts";
import { collectScope } from "./review-scope.ts";

function run(cwd: string, command: string, args: string[]): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout.trim();
}

const realExec: ExecFn = async (command, args, options): Promise<ExecFnResult> => {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		timeout: options.timeout,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		code: result.status ?? 1,
		stdout: result.stdout,
		stderr: result.stderr || result.error?.message || "",
	};
};

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;

describe("jj panel-review target", () => {
	it("returns null outside a jj workspace", () => {
		const dir = mkdtempSync(join(tmpdir(), "panel-not-jj-"));
		try {
			assert.equal(resolveJjReviewTarget(dir, "main"), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("pins and snapshots @ from a secondary workspace without a .git entry", { skip: !hasJj }, async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-jj-source-"));
		const workspace = join(root, "secondary");
		const repo = join(root, "repo");
		let bundleDir: string | undefined;
		let snapshotRoot: string | undefined;
		try {
			run(root, "git", ["init", "-q", repo]);
			run(repo, "git", ["config", "user.email", "test@example.com"]);
			run(repo, "git", ["config", "user.name", "Test"]);
			writeFileSync(join(repo, "file.txt"), "base\n");
			run(repo, "git", ["add", "file.txt"]);
			run(repo, "git", ["commit", "-qm", "base"]);
			run(repo, "jj", ["git", "init", "--colocate"]);
			run(repo, "jj", ["workspace", "add", workspace]);
			writeFileSync(join(workspace, "file.txt"), "secondary workspace\n");
			run(workspace, "jj", ["describe", "-m", "secondary change"]);

			assert.equal(existsSync(join(workspace, ".git")), false);
			const target = resolveJjReviewTarget(workspace, "main");
			assert.ok(target);
			assert.equal(target.workspaceRoot, realpathSync(workspace));
			assert.equal(target.headSha, run(workspace, "jj", ["log", "--no-graph", "-r", "@", "-T", "commit_id"]));

			const gitExec = createGitStoreExec(target.gitRoot);
			const scope = collectScope(target.workspaceRoot, target.base, "review secondary", {
				exec: gitExec,
				headSha: target.headSha,
				repositoryRoot: target.workspaceRoot,
			});
			bundleDir = scope.dir;
			const bundle = readFileSync(scope.path, "utf8");
			assert.match(bundle, /secondary change/);
			assert.match(bundle, /secondary workspace/);
			assert.equal(scope.headSha, target.headSha);

			const gitStoreExec: ExecFn = (command, args, options) =>
				realExec(command, command === "git" ? [`--git-dir=${target.gitRoot}`, ...args] : args, options);
			const snapshot = await materializePrSnapshot(gitStoreExec, target.workspaceRoot, target.headSha);
			snapshotRoot = snapshot.root;
			assert.equal(readFileSync(join(snapshot.directory, "file.txt"), "utf8"), "secondary workspace\n");
		} finally {
			if (snapshotRoot) rmSync(snapshotRoot, { recursive: true, force: true });
			if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});
