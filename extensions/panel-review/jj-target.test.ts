import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { resolveJjReviewTarget } from "./jj-target.ts";
import { materializePrSnapshot } from "./pr-target.ts";
import { type CommandExec, locateRepositorySource, type RepositorySource } from "./repository-source.ts";
import { collectScope } from "./review-scope.ts";

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	assert.equal(result.status, 0, result.stderr || result.error?.message);
	return result.stdout.trim();
}

const createRealExec =
	(env?: NodeJS.ProcessEnv): ExecFn =>
	async (command, args, options): Promise<ExecFnResult> => {
		const result = spawnSync(command, args, {
			cwd: options.cwd,
			env,
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

/** Seed a jj repository whose `main` bookmark holds one base commit. */
function seedJjRepo(repo: string, env: NodeJS.ProcessEnv, colocate: boolean): void {
	run(repo, "jj", ["git", "init", colocate ? "--colocate" : "--no-colocate"], env);
	writeFileSync(join(repo, "file.txt"), "base\n");
	run(repo, "jj", ["describe", "-m", "base"], env);
	run(repo, "jj", ["bookmark", "create", "main", "-r", "@"], env);
	run(repo, "jj", ["new"], env);
}

function locate(path: string, env: NodeJS.ProcessEnv): RepositorySource {
	const commandExec: CommandExec = (cmd, args, cwd) => run(cwd, cmd, args, env);
	return locateRepositorySource(path, createRealExec(env), commandExec);
}

async function reviewWorkingCopy(source: RepositorySource, env: NodeJS.ProcessEnv, explicitBase?: string) {
	const commandExec: CommandExec = (cmd, args, cwd) => run(cwd, cmd, args, env);
	const statusBefore = run(source.root, "jj", ["status", "--no-pager"], env);
	const target = resolveJjReviewTarget(source, explicitBase, commandExec);
	assert.equal(target.headSha, run(source.root, "jj", ["log", "--no-graph", "-r", "@", "-T", "commit_id"], env));
	const scope = collectScope(source.root, target.base, "review", {
		exec: source.git,
		headSha: target.headSha,
		repositoryRoot: source.root,
	});
	const snapshot = await materializePrSnapshot(source.exec, source.root, target.headSha, {
		objectProcess: { env },
	});
	try {
		const result = {
			target,
			bundle: readFileSync(scope.path, "utf8"),
			file: readFileSync(join(snapshot.directory, "file.txt"), "utf8"),
		};
		assert.equal(run(source.root, "jj", ["status", "--no-pager"], env), statusBefore);
		assert.equal(run(source.root, "jj", ["log", "--no-graph", "-r", "@", "-T", "commit_id"], env), target.headSha);
		return result;
	} finally {
		rmSync(snapshot.root, { recursive: true, force: true });
		rmSync(scope.dir, { recursive: true, force: true });
	}
}

describe("jj panel-review target", () => {
	for (const colocate of [true, false]) {
		const label = colocate ? "colocated" : "non-colocated";

		it(`pins @ in a ${label} primary workspace with a local main fallback for trunk()`, { skip: !hasJj }, async () => {
			const root = mkdtempSync(join(tmpdir(), "panel-jj-primary-"));
			const env = createVcsTestEnv(root);
			const repo = join(root, "repo");
			try {
				run(root, "mkdir", [repo]);
				seedJjRepo(repo, env, colocate);
				writeFileSync(join(repo, "file.txt"), "primary change\n");
				run(repo, "jj", ["describe", "-m", "primary change"], env);

				const source = locate(repo, env);
				assert.equal(source.root, realpathSync(repo));
				assert.equal(source.layout, colocate ? "jj-colocated" : "jj-workspace");
				assert.ok(source.gitDir);
				assert.equal(existsSync(join(repo, ".git")), colocate);

				const { target, bundle, file } = await reviewWorkingCopy(source, env);
				assert.equal(target.base.strategy, "main");
				assert.equal(target.warnings.length, 1);
				assert.match(target.warnings[0], /root commit/);
				assert.match(bundle, /primary change/);
				assert.equal(file, "primary change\n");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it(`pins @ in a ${label} secondary workspace without its own .git entry`, { skip: !hasJj }, async () => {
			const root = mkdtempSync(join(tmpdir(), "panel-jj-secondary-"));
			const env = createVcsTestEnv(root);
			const repo = join(root, "repo");
			const workspace = join(root, "secondary");
			try {
				run(root, "mkdir", [repo]);
				seedJjRepo(repo, env, colocate);
				run(repo, "jj", ["workspace", "add", workspace], env);
				writeFileSync(join(workspace, "file.txt"), "secondary workspace\n");
				run(workspace, "jj", ["describe", "-m", "secondary change"], env);

				assert.equal(existsSync(join(workspace, ".git")), false);
				const source = locate(workspace, env);
				assert.equal(source.root, realpathSync(workspace));
				assert.equal(source.layout, "jj-workspace");

				const { target, bundle, file } = await reviewWorkingCopy(source, env, "main");
				assert.equal(target.base.strategy, "explicit");
				assert.deepEqual(target.warnings, []);
				assert.match(bundle, /secondary change/);
				assert.match(bundle, /secondary workspace/);
				assert.equal(file, "secondary workspace\n");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	it("fails clearly when trunk() is the root commit and no local main exists", { skip: !hasJj }, () => {
		const root = mkdtempSync(join(tmpdir(), "panel-jj-notrunk-"));
		const env = createVcsTestEnv(root);
		try {
			run(root, "jj", ["git", "init", "--colocate"], env);
			writeFileSync(join(root, "file.txt"), "x\n");
			const source = locate(root, env);
			assert.throws(
				() => resolveJjReviewTarget(source, undefined, (cmd, args, cwd) => run(cwd, cmd, args, env)),
				/Pass --base/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
