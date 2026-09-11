import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { visibleWidthFallback } from "../shared/terminal-text.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { resolveJjReviewTarget } from "./jj-target.ts";
import { discoverJjWorkspaces, formatJjWorkspaceChoice, type JjWorkspaceChoice } from "./jj-workspaces.ts";
import { type CommandExec, locateRepositorySource } from "./repository-source.ts";
import { collectScope } from "./review-scope.ts";

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;

interface WorkspaceRecordOverrides {
	name?: string;
	root?: string | null;
	changeId?: string;
	bookmarks?: Array<string | number>;
	description?: string;
}

function record(overrides: WorkspaceRecordOverrides = {}): string {
	return JSON.stringify({
		name: "default",
		root: "/repo",
		changeId: "a".repeat(32),
		bookmarks: [],
		description: "",
		...overrides,
	});
}

describe("discoverJjWorkspaces", () => {
	it("returns live canonical roots with the current workspace first", () => {
		const output = [
			record({
				name: "task",
				root: "/link/task",
				changeId: "b".repeat(32),
				bookmarks: ["kstack/task"],
				description: "Implement task",
			}),
			record(),
			record({ name: "old", root: null }),
			record({ name: "missing", root: "/gone" }),
		].join("\n");
		const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

		const workspaces = discoverJjWorkspaces({
			currentRoot: "/real/repo",
			exec: (command, args, cwd) => {
				calls.push({ command, args, cwd });
				return output;
			},
			exists: (path) => path !== "/gone",
			realpath: (path) => (path === "/repo" ? "/real/repo" : path === "/link/task" ? "/real/task" : path),
		});

		assert.deepEqual(
			workspaces.map(({ name, root, current, bookmarks, description }) => ({
				name,
				root,
				current,
				bookmarks,
				description,
			})),
			[
				{ name: "default", root: "/real/repo", current: true, bookmarks: [], description: "" },
				{
					name: "task",
					root: "/real/task",
					current: false,
					bookmarks: ["kstack/task"],
					description: "Implement task",
				},
			],
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.command, "jj");
		assert.deepEqual(calls[0]?.args.slice(0, 3), ["--ignore-working-copy", "workspace", "list"]);
		assert.equal(calls[0]?.cwd, "/real/repo");
	});

	it("selects a secondary workspace target without reading the primary workspace changes", { skip: !hasJj }, () => {
		const root = mkdtempSync(join(tmpdir(), "panel-workspace-selection-"));
		const repo = join(root, "repo");
		const secondary = join(root, "secondary");
		const env = createVcsTestEnv(root);
		const run = (cwd: string, command: string, args: string[]) => {
			const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			assert.equal(result.status, 0, result.stderr || result.error?.message);
			return result.stdout.trim();
		};
		const commandExec: CommandExec = (command, args, cwd) => run(cwd, command, args);
		const asyncExec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "not used" });
		let scopeDir: string | undefined;

		try {
			mkdirSync(repo);
			run(repo, "jj", ["git", "init", "--colocate"]);
			writeFileSync(join(repo, "file.txt"), "base\n");
			run(repo, "jj", ["describe", "-m", "base"]);
			run(repo, "jj", ["bookmark", "create", "main", "-r", "@"]);
			run(repo, "jj", ["new"]);
			run(repo, "jj", ["workspace", "add", secondary]);
			writeFileSync(join(repo, "file.txt"), "primary workspace\n");
			run(repo, "jj", ["describe", "-m", "primary change"]);
			writeFileSync(join(secondary, "file.txt"), "secondary workspace\n");
			run(secondary, "jj", ["describe", "-m", "secondary change"]);
			const primaryStatus = run(repo, "jj", ["status", "--no-pager"]);

			const primarySource = locateRepositorySource(repo, asyncExec, commandExec);
			const workspaces = discoverJjWorkspaces({ currentRoot: primarySource.root, exec: commandExec });
			const selected = workspaces.find((workspace) => workspace.name === "secondary");
			assert.ok(selected);
			const selectedSource = locateRepositorySource(selected.root, asyncExec, commandExec);
			assert.equal(selectedSource.gitDir, primarySource.gitDir);
			const target = resolveJjReviewTarget(selectedSource, "main", commandExec);
			const scope = collectScope(selectedSource.root, target.base, "review secondary", {
				exec: selectedSource.git,
				headSha: target.headSha,
				repositoryRoot: selectedSource.root,
			});
			scopeDir = scope.dir;
			const bundle = readFileSync(scope.path, "utf8");
			assert.match(bundle, /secondary workspace/);
			assert.doesNotMatch(bundle, /primary workspace/);
			assert.equal(run(repo, "jj", ["status", "--no-pager"]), primaryStatus);
		} finally {
			if (scopeDir) rmSync(scopeDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed, duplicate, oversized, and incomplete workspace data", () => {
		const run = (output: string) =>
			discoverJjWorkspaces({
				currentRoot: "/repo",
				exec: () => output,
				exists: () => true,
				realpath: (path) => path,
			});

		assert.throws(() => run(record({ bookmarks: [42] })), /invalid jj workspace record/);
		assert.throws(() => run(`${record()}\n${record({ name: "alias" })}`), /same root/);
		assert.throws(() => run(record({ root: null })), /current jj workspace/);
		assert.throws(() => run("x".repeat(1024 * 1024 + 1)), /exceeded/);
		assert.throws(
			() =>
				run(
					Array.from({ length: 201 }, (_, index) => record({ name: `ws-${index}`, root: `/ws/${index}` })).join("\n"),
				),
			/more than 200/,
		);
	});
});

describe("formatJjWorkspaceChoice", () => {
	it("shows useful identity, strips controls, and bounds the selector label", () => {
		const workspace: JjWorkspaceChoice = {
			name: "task\u001b[31m",
			root: `/workspace/${"x".repeat(400)}`,
			changeId: "abcdefghijklmnop",
			bookmarks: ["kstack/task"],
			description: "Implement\ntask",
			current: false,
		};
		const label = formatJjWorkspaceChoice({ workspace, index: 1 });

		assert.match(label, /^2\. task · @ abcdefgh · kstack\/task · /);
		assert.equal(label.includes("\u001b"), false);
		assert.equal(label.includes("\n"), false);
		assert.ok(visibleWidthFallback(label) <= 240);
	});
});
