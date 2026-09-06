import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { GitHubError, type GitHubGateway, type OpenPullRequest } from "../shared/github.ts";
import { buildNavigationComment } from "../shared/stack/topology.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { requestGitHubStackLanding } from "./landing.ts";

const one = "b".repeat(40);
const two = "c".repeat(40);
const three = "e".repeat(40);
const merged = "d".repeat(40);
const entries = [
	{ prNumber: 1, bookmark: "kstack/one", base: "main", status: "open" as const },
	{ prNumber: 2, bookmark: "kstack/two", base: "kstack/one", status: "open" as const },
];

function worktreeRecord(path: string, branch: string, head: string): string {
	return `worktree ${path}\0HEAD ${head}\0branch refs/heads/${branch}\0\0`;
}

function localRefInventory(items: ReadonlyArray<readonly [string, string]>): string {
	return `${items.map(([branch, sha]) => `refs/heads/${branch}\t${sha}`).join("\n")}\n`;
}

function pr(number: number, headRef: string, headCommitId: string, baseRef: string): OpenPullRequest {
	return {
		number,
		headRef,
		headCommitId,
		baseRef,
		title: headRef,
		draft: false,
		url: `https://github.com/o/r/pull/${number}`,
		headOwner: "o",
	};
}

function gateway(withComment = true): GitHubGateway {
	const prs = [pr(1, "kstack/one", one, "main"), pr(2, "kstack/two", two, "kstack/one")];
	return {
		getDefaultBranch: async () => "main",
		listOpenPrs: async () => prs,
		listPrsForHead: async (_repo, head) => prs.filter((item) => item.headRef === head),
		getAuthenticatedUser: async () => "me",
		getPrStatus: async () => "open",
		getPrComments: async () =>
			withComment ? [{ id: 1, user: "me", body: buildNavigationComment(entries, "main") }] : [],
		getMergeCommit: async () => ({
			merged: false,
			mergeCommitOid: undefined,
			headCommitId: one,
			headRef: "kstack/one",
		}),
		getAllowedMergeMethods: async () => ["squash"],
		getRemoteBranchSha: async () => undefined,
		markPrReady: async () => {},
		deleteRemoteBranch: async () => ({ kind: "deleted" as const }),
		createDraftPr: async () => prs[0],
		updatePrBase: async () => {},
		createOrUpdateComment: async () => ({ id: 1 }),
	};
}

function exec(
	localBranches = true,
	overrides: Record<string, { code?: number; stdout?: string; stderr?: string }> = {},
): ExecFn {
	return async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		const values = {
			"git remote": { stdout: "origin\n" },
			"git remote get-url origin": { stdout: "https://github.com/o/r.git\n" },
			"git --version": { stdout: "git version 2.38.0\n" },
			"git status --porcelain=v1 --untracked-files=all": {},
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"git rev-parse --verify refs/heads/kstack/one^{commit}": localBranches ? { stdout: `${one}\n` } : { code: 1 },
			"git rev-parse --verify refs/heads/kstack/two^{commit}": localBranches ? { stdout: `${two}\n` } : { code: 1 },
			"git for-each-ref --format=%(refname)%09%(objectname) refs/heads": {
				stdout: localRefInventory([
					["kstack/one", one],
					["kstack/two", two],
				]),
			},
			"git worktree list --porcelain -z": { stdout: worktreeRecord("/repo", "kstack/two", two) },
			[`git merge-base --is-ancestor ${one} ${two}`]: {},
			[`git rev-list --reverse ${one}..${two}`]: { stdout: `${two}\n` },
			[`git rev-list --min-parents=2 ${one}..${two}`]: {},
			[`git merge-base --is-ancestor ${merged} ${two}`]: {},
			[`git rev-list --reverse ${merged}..${two}`]: { stdout: `${two}\n` },
		} satisfies Record<string, { code?: number; stdout?: string; stderr?: string }>;
		const responses = new Map<string, { code?: number; stdout?: string; stderr?: string }>(Object.entries(values));
		const value = overrides[key] ?? responses.get(key) ?? {};
		return { code: value.code ?? 0, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
	};
}

async function runInvalidPostRebaseScenario(kind: "added-ref" | "moved-ref" | "stale-ancestry" | "late-inventory") {
	const mergeCommit = "d".repeat(40);
	let rebased = false;
	let refInventoryCalls = 0;
	const calls: string[] = [];
	const baseExec = exec(true, {
		"git fetch origin": {},
		"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
		"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${mergeCommit}\n` },
		[`git merge-base --is-ancestor ${mergeCommit} ${mergeCommit}`]: {},
	});
	const scenarioExec: ExecFn = async (command, args, options) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (key === `git rebase --onto refs/remotes/origin/main ${one} kstack/two --update-refs`) {
			rebased = true;
			return { code: 0, stdout: "", stderr: "" };
		}
		if (key === "git for-each-ref --format=%(refname)%09%(objectname) refs/heads") {
			refInventoryCalls++;
			if (kind === "late-inventory" && refInventoryCalls === 3) {
				return { code: 1, stdout: "", stderr: "inventory unavailable" };
			}
			const refs: Array<readonly [string, string]> = [
				["kstack/one", one],
				["kstack/two", two],
				["outside", rebased && kind === "moved-ref" ? three : one],
			];
			if (rebased && kind === "added-ref") refs.push(["new-alias", one]);
			return { code: 0, stdout: localRefInventory(refs), stderr: "" };
		}
		if (rebased && kind === "stale-ancestry" && key === `git merge-base --is-ancestor ${mergeCommit} ${two}`) {
			return { code: 1, stdout: "", stderr: "" };
		}
		return baseExec(command, args, options);
	};
	let baseUpdates = 0;
	let navigationWrites = 0;
	let remoteDeletes = 0;
	const base = gateway();
	const result = await requestGitHubStackLanding(
		{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
		{
			exec: scenarioExec,
			gateway: {
				...base,
				getPrStatus: async (_repo, prNumber) => (prNumber === 1 ? "merged" : "open"),
				getMergeCommit: async () => ({
					merged: true,
					mergeCommitOid: mergeCommit,
					headCommitId: one,
					headRef: "kstack/one",
				}),
				updatePrBase: async () => {
					baseUpdates++;
				},
				createOrUpdateComment: async () => {
					navigationWrites++;
					return { id: 1 };
				},
				deleteRemoteBranch: async () => {
					remoteDeletes++;
					return { kind: "deleted" as const };
				},
			},
			confirm: async () => true,
			selectMethod: async () => "squash",
			landFrontier: async () => ({ handled: false }),
			acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
			realpath: (path) => path,
		},
	);
	return { result, calls, baseUpdates, navigationWrites, remoteDeletes };
}

describe("GitHub stack landing", () => {
	interface CleanupGitFixture {
		root: string;
		repo: string;
		env: NodeJS.ProcessEnv;
		oneSha: string;
		twoSha: string;
		mergeSha: string;
	}

	function runGit(fixture: Pick<CleanupGitFixture, "repo" | "env">, args: string[], cwd = fixture.repo): string {
		const completed = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			env: fixture.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
		return completed.stdout.trim();
	}

	function commitFile(
		fixture: Pick<CleanupGitFixture, "repo" | "env">,
		name: string,
		contents: string,
		message: string,
	): string {
		writeFileSync(join(fixture.repo, name), contents, "utf8");
		runGit(fixture, ["add", name]);
		runGit(fixture, ["commit", "-qm", message]);
		return runGit(fixture, ["rev-parse", "HEAD"]);
	}

	function createRealGitExec(env: NodeJS.ProcessEnv): ExecFn {
		return (command, args, options) => {
			const completed = spawnSync(command, args, {
				cwd: options.cwd,
				encoding: "utf8",
				env,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: options.timeout,
			});
			return Promise.resolve({
				code: completed.status ?? 1,
				stdout: completed.stdout,
				stderr: completed.stderr || completed.error?.message || "",
			});
		};
	}

	function readLandingHeads(fixture: Pick<CleanupGitFixture, "repo" | "env">): Map<string, string> {
		const output = runGit(fixture, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"]);
		return new Map(
			output
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const [branch, sha] = line.split("\t");
					return [branch, sha];
				}),
		);
	}

	function createCleanupFixture(): CleanupGitFixture {
		const root = mkdtempSync(join(tmpdir(), "github-landing-cleanup-"));
		const repo = join(root, "repo");
		mkdirSync(repo);
		const env = createVcsTestEnv(root);
		const partial = { repo, env };
		runGit(partial, ["init", "-q"]);
		commitFile(partial, "base.txt", "base\n", "base");
		runGit(partial, ["branch", "-M", "main"]);
		runGit(partial, ["switch", "-qc", "kstack/one"]);
		const oneSha = commitFile(partial, "one.txt", "one\n", "one");
		runGit(partial, ["switch", "-qc", "kstack/two"]);
		const twoSha = commitFile(partial, "two.txt", "two\n", "two");
		runGit(partial, ["switch", "-q", "main"]);
		runGit(partial, ["merge", "--squash", "kstack/one"]);
		const mergeSha = commitFile(partial, "one.txt", "one\n", "squash one");
		const origin = join(root, "origin.git");
		mkdirSync(origin);
		runGit(partial, ["init", "-q", "--bare", origin]);
		runGit(partial, ["remote", "add", "origin", "git@github.com:o/r.git"]);
		// Make the GitHub-shaped remote URL fetchable from the disposable bare clone.
		runGit(partial, ["config", `url.${origin}.insteadOf`, "git@github.com:o/r.git"]);
		runGit(partial, ["push", "-q", "origin", "main", "kstack/one", "kstack/two"]);
		runGit(partial, ["remote", "set-head", "origin", "--auto"]);
		runGit(partial, ["switch", "-q", "kstack/two"]);
		return { root, repo, env, oneSha, twoSha, mergeSha };
	}

	it("keeps a local landed branch that advanced after verification and warns instead of deleting", async () => {
		const fixture = createCleanupFixture();
		try {
			const pushed: string[] = [];
			const advanced = { value: "" };
			const innerExec = createRealGitExec(fixture.env);
			const racingExec: ExecFn = async (command, args, options) => {
				// Report the GitHub-shaped remote URL while every other command runs
				// against the disposable real repository.
				if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
					return { code: 0, stdout: "git@github.com:o/r.git\n", stderr: "" };
				}
				const result = await innerExec(command, args, options);
				// Advance the landed branch once the remainder push has succeeded,
				// immediately before cleanup runs.
				if (command === "git" && args[0] === "push" && result.code === 0) {
					pushed.push(args.join(" "));
					const update = spawnSync("git", ["update-ref", `refs/heads/kstack/one`, fixture.mergeSha], {
						cwd: fixture.repo,
						encoding: "utf8",
						env: fixture.env,
						stdio: ["ignore", "pipe", "pipe"],
					});
					assert.equal(update.status, 0, update.stderr);
					advanced.value = "advanced";
				}
				return result;
			};
			const base = gateway();
			const stackEntries = entries;
			const prs = [pr(1, "kstack/one", fixture.oneSha, "main"), pr(2, "kstack/two", fixture.twoSha, "kstack/one")];
			const result = await requestGitHubStackLanding(
				{ cwd: fixture.repo, prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
				{
					exec: racingExec,
					gateway: {
						...base,
						listOpenPrs: async () => prs,
						listPrsForHead: async (_repo, head) => prs.filter((item) => item.headRef === head),
						getPrStatus: async (_repo, prNumber) => (prNumber === 1 ? "merged" : "open"),
						getPrComments: async () => [{ id: 1, user: "me", body: buildNavigationComment(stackEntries, "main") }],
						getMergeCommit: async () => ({
							merged: true,
							mergeCommitOid: fixture.mergeSha,
							headCommitId: fixture.oneSha,
							headRef: "kstack/one",
						}),
						getRemoteBranchSha: async (_repo, branch) => {
							if (branch === "kstack/one") return fixture.oneSha;
							if (branch === "kstack/two") return fixture.twoSha;
							return undefined;
						},
					},
					confirm: async () => true,
					selectMethod: async () => "squash",
					landFrontier: async () => ({ handled: false }),
					acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
					realpath: realpathSync,
				},
			);
			assert.equal(result.status === "stack" ? result.outcome.status : "", "completed");
			assert.equal(pushed.length, 1);
			assert.equal(advanced.value, "advanced");
			const heads = readLandingHeads(fixture);
			assert.equal(heads.get("kstack/one"), fixture.mergeSha);
			assert.ok(
				result.status === "stack" &&
					result.outcome.status === "completed" &&
					result.outcome.warnings.some((warning) => /kstack\/one/.test(warning)),
				`expected a retained-branch warning, got: ${JSON.stringify(
					result.status === "stack" && result.outcome.status === "completed" ? result.outcome.warnings : [],
				)}`,
			);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("falls through when the selected PR has no stack membership", async () => {
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: exec(),
				gateway: gateway(false),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({ handled: false }),
			},
		);
		assert.deepEqual(result, { status: "not-stack" });
	});

	it("falls through for a one-entry navigation comment", async () => {
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: exec(),
				gateway: {
					...base,
					getPrComments: async () => [{ id: 1, user: "me", body: buildNavigationComment([entries[0]], "main") }],
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({ handled: false }),
			},
		);
		assert.deepEqual(result, { status: "not-stack" });
	});

	it("routes the bottom PR of a multi-PR stack through stack orchestration", async () => {
		let delegated = false;
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: exec(),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => {
					delegated = true;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(delegated, true);
		assert.equal(result.status === "stack" ? result.outcome.status : "not-stack", "blocked");
	});

	it("reports remote inspection failures during automatic remote discovery", async () => {
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: exec(),
				gateway: {
					...base,
					listPrsForHead: async () => {
						throw new Error("GitHub authentication failed");
					},
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({ handled: false }),
			},
		);
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/authentication failed/,
		);
	});

	it("reports genuinely ambiguous GitHub remotes", async () => {
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: exec(true, {
					"git remote": { stdout: "origin\nupstream\n" },
					"git remote get-url upstream": { stdout: "https://github.com/other/r.git\n" },
				}),
				gateway: { ...base, listPrsForHead: async (_repo, head) => [pr(2, head, two, "kstack/one")] },
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({ handled: false }),
			},
		);
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/multiple GitHub repositories.*o\/r.*other\/r/i,
		);
	});

	it("blocks when a required local branch is absent", async () => {
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: exec(false),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({ handled: false }),
			},
		);
		assert.equal(result.status, "stack");
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/Local branch kstack\/one/,
		);
	});

	it("blocks a local alias inside the rewrite scope before landing the frontier", async () => {
		let landCalls = 0;
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: exec(true, {
					"git for-each-ref --format=%(refname)%09%(objectname) refs/heads": {
						stdout: `refs/heads/kstack/one\t${one}\nrefs/heads/kstack/two\t${two}\nrefs/heads/local-alias\t${two}\n`,
					},
				}),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => {
					landCalls++;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(landCalls, 0);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "blocked");
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/local-alias.*rewrite range/,
		);
	});

	it("blocks the top checked out in another worktree before landing the frontier", async () => {
		let landCalls = 0;
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: exec(true, {
					"git worktree list --porcelain -z": {
						stdout: worktreeRecord("/other worktree", "kstack/two", two),
					},
				}),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => {
					landCalls++;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(landCalls, 0);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "blocked");
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/another worktree/,
		);
	});

	it("blocks an intermediate branch checked out in another worktree before landing", async () => {
		const stackEntries = [
			entries[0],
			entries[1],
			{ prNumber: 3, bookmark: "kstack/three", base: "kstack/two", status: "open" as const },
		];
		const prs = [
			pr(1, "kstack/one", one, "main"),
			pr(2, "kstack/two", two, "kstack/one"),
			pr(3, "kstack/three", three, "kstack/two"),
		];
		let landCalls = 0;
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: exec(true, {
					"git rev-parse --verify refs/heads/kstack/three^{commit}": { stdout: `${three}\n` },
					"git for-each-ref --format=%(refname)%09%(objectname) refs/heads": {
						stdout: localRefInventory([
							["kstack/one", one],
							["kstack/two", two],
							["kstack/three", three],
						]),
					},
					"git worktree list --porcelain -z": {
						stdout:
							worktreeRecord("/middle worktree", "kstack/two", two) + worktreeRecord("/repo", "kstack/three", three),
					},
					[`git merge-base --is-ancestor ${one} ${three}`]: {},
					[`git rev-list --reverse ${one}..${three}`]: { stdout: `${two}\n${three}\n` },
					[`git rev-list --min-parents=2 ${one}..${three}`]: {},
				}),
				gateway: {
					...base,
					listOpenPrs: async () => prs,
					listPrsForHead: async (_repo, head) => prs.filter((item) => item.headRef === head),
					getPrComments: async () => [{ id: 1, user: "me", body: buildNavigationComment(stackEntries, "main") }],
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => {
					landCalls++;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(landCalls, 0);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "blocked");
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/kstack\/two.*checked out.*middle worktree/,
		);
	});

	it("rechecks the confirmed scope under the publication lock", async () => {
		let confirmed = false;
		let landCalls = 0;
		const baseExec = exec();
		const changingExec: ExecFn = (command, args, options) => {
			const key = `${command} ${args.join(" ")}`;
			if (confirmed && key === "git for-each-ref --format=%(refname)%09%(objectname) refs/heads") {
				return Promise.resolve({
					code: 0,
					stdout: localRefInventory([
						["kstack/one", one],
						["kstack/two", two],
						["new-alias", two],
					]),
					stderr: "",
				});
			}
			return baseExec(command, args, options);
		};
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: changingExec,
				gateway: gateway(),
				confirm: async () => {
					confirmed = true;
					return true;
				},
				selectMethod: async () => "squash",
				landFrontier: async () => {
					landCalls++;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(landCalls, 0);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "blocked");
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/new-alias.*rewrite range/,
		);
	});

	it("blocks pinned branch drift introduced during confirmation", async () => {
		let confirmed = false;
		let landCalls = 0;
		const baseExec = exec();
		const driftingExec: ExecFn = (command, args, options) => {
			const key = `${command} ${args.join(" ")}`;
			if (confirmed && key === "git rev-parse --verify refs/heads/kstack/two^{commit}") {
				return Promise.resolve({ code: 0, stdout: `${three}\n`, stderr: "" });
			}
			return baseExec(command, args, options);
		};
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: driftingExec,
				gateway: gateway(),
				confirm: async () => {
					confirmed = true;
					return true;
				},
				selectMethod: async () => "squash",
				landFrontier: async () => {
					landCalls++;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(landCalls, 0);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "blocked");
		assert.match(
			result.status === "stack" && result.outcome.status === "blocked" ? result.outcome.blockers[0].message : "",
			/does not match PR #2 head/,
		);
	});

	it("rechecks scope before each later frontier merge", async () => {
		const mergeCommit = "d".repeat(40);
		const stackEntries = [
			entries[0],
			entries[1],
			{ prNumber: 3, bookmark: "kstack/three", base: "kstack/two", status: "open" as const },
		];
		const prs = [
			pr(1, "kstack/one", one, "main"),
			pr(2, "kstack/two", two, "kstack/one"),
			pr(3, "kstack/three", three, "kstack/two"),
		];
		let firstPushCompleted = false;
		let landCalls = 0;
		const baseExec = exec(true, {
			"git fetch origin": {},
			"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
			"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${mergeCommit}\n` },
			[`git merge-base --is-ancestor ${mergeCommit} ${mergeCommit}`]: {},
		});
		const stackExec: ExecFn = async (command, args, options) => {
			const key = `${command} ${args.join(" ")}`;
			if (key === "git rev-parse --verify refs/heads/kstack/three^{commit}") {
				return { code: 0, stdout: `${three}\n`, stderr: "" };
			}
			if (key === "git for-each-ref --format=%(refname)%09%(objectname) refs/heads") {
				const refs: Array<readonly [string, string]> = [
					["kstack/one", one],
					["kstack/two", two],
					["kstack/three", three],
				];
				if (firstPushCompleted) refs.push(["later-alias", three]);
				return { code: 0, stdout: localRefInventory(refs), stderr: "" };
			}
			if (key === "git worktree list --porcelain -z") {
				return { code: 0, stdout: worktreeRecord("/repo", "kstack/three", three), stderr: "" };
			}
			if (key === `git rev-list --reverse ${one}..${three}`) {
				return { code: 0, stdout: `${two}\n${three}\n`, stderr: "" };
			}
			if (key === `git rev-list --reverse ${two}..${three}`) {
				return { code: 0, stdout: `${three}\n`, stderr: "" };
			}
			if (key === `git rev-list --reverse ${mergeCommit}..${three}`) {
				return { code: 0, stdout: `${two}\n${three}\n`, stderr: "" };
			}
			if (key.startsWith("git push --atomic ")) firstPushCompleted = true;
			return baseExec(command, args, options);
		};
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: stackExec,
				gateway: {
					...base,
					listOpenPrs: async () => prs,
					listPrsForHead: async (_repo, head) => prs.filter((item) => item.headRef === head),
					getPrStatus: async (_repo, prNumber) => (prNumber === 1 ? "merged" : "open"),
					getPrComments: async () => [{ id: 1, user: "me", body: buildNavigationComment(stackEntries, "main") }],
					getMergeCommit: async () => ({
						merged: true,
						mergeCommitOid: mergeCommit,
						headCommitId: one,
						headRef: "kstack/one",
					}),
					getRemoteBranchSha: async (_repo, branch) => {
						if (branch === "kstack/two") return two;
						if (branch === "kstack/three") return three;
						return branch === "kstack/one" ? one : undefined;
					},
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => {
					landCalls++;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(firstPushCompleted, true);
		assert.equal(landCalls, 0);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "partial");
		assert.match(
			result.status === "stack" && result.outcome.status === "partial" ? result.outcome.error : "",
			/later-alias.*rewrite range/,
		);
	});

	it("atomically republishes every remainder branch with exact leases", async () => {
		const mergeCommit = "d".repeat(40);
		const rebasedTwo = "f".repeat(40);
		const rebasedThree = "1".repeat(40);
		const stackEntries = [
			entries[0],
			entries[1],
			{ prNumber: 3, bookmark: "kstack/three", base: "kstack/two", status: "open" as const },
		];
		const prs = [
			pr(1, "kstack/one", one, "main"),
			pr(2, "kstack/two", two, "kstack/one"),
			pr(3, "kstack/three", three, "kstack/two"),
		];
		let rebased = false;
		const calls: string[] = [];
		const baseExec = exec(true, {
			"git fetch origin": {},
			"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
			"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${mergeCommit}\n` },
			[`git merge-base --is-ancestor ${mergeCommit} ${mergeCommit}`]: {},
		});
		const stackExec: ExecFn = async (command, args, options) => {
			const key = `${command} ${args.join(" ")}`;
			calls.push(key);
			if (key === `git rebase --onto refs/remotes/origin/main ${one} kstack/three --update-refs`) {
				rebased = true;
				return { code: 0, stdout: "", stderr: "" };
			}
			if (key === "git rev-parse --verify refs/heads/kstack/two^{commit}") {
				return { code: 0, stdout: `${rebased ? rebasedTwo : two}\n`, stderr: "" };
			}
			if (key === "git rev-parse --verify refs/heads/kstack/three^{commit}") {
				return { code: 0, stdout: `${rebased ? rebasedThree : three}\n`, stderr: "" };
			}
			if (key === "git for-each-ref --format=%(refname)%09%(objectname) refs/heads") {
				return {
					code: 0,
					stdout: localRefInventory([
						["kstack/one", one],
						["kstack/two", rebased ? rebasedTwo : two],
						["kstack/three", rebased ? rebasedThree : three],
					]),
					stderr: "",
				};
			}
			if (key === "git worktree list --porcelain -z") {
				return {
					code: 0,
					stdout: worktreeRecord("/repo", "kstack/three", rebased ? rebasedThree : three),
					stderr: "",
				};
			}
			if (key === `git rev-list --reverse ${one}..${three}`) {
				return { code: 0, stdout: `${two}\n${three}\n`, stderr: "" };
			}
			if (key === `git rev-list --reverse ${mergeCommit}..${rebasedThree}`) {
				return { code: 0, stdout: `${rebasedTwo}\n${rebasedThree}\n`, stderr: "" };
			}
			return baseExec(command, args, options);
		};
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
			{
				exec: stackExec,
				gateway: {
					...base,
					listOpenPrs: async () => prs,
					listPrsForHead: async (_repo, head) => prs.filter((item) => item.headRef === head),
					getPrStatus: async (_repo, prNumber) => (prNumber === 1 ? "merged" : "open"),
					getPrComments: async () => [{ id: 1, user: "me", body: buildNavigationComment(stackEntries, "main") }],
					getMergeCommit: async () => ({
						merged: true,
						mergeCommitOid: mergeCommit,
						headCommitId: one,
						headRef: "kstack/one",
					}),
					getRemoteBranchSha: async (_repo, branch) => {
						if (branch === "kstack/two") return two;
						if (branch === "kstack/three") return three;
						return undefined;
					},
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({ handled: false }),
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "completed");
		const pushes = calls.filter((call) => call.startsWith("git push "));
		assert.equal(pushes.length, 1);
		assert.match(pushes[0], /--atomic/);
		assert.match(pushes[0], new RegExp(`${rebasedTwo}:refs/heads/kstack/two`));
		assert.match(pushes[0], new RegExp(`${rebasedThree}:refs/heads/kstack/three`));
	});

	it("skips rewrite-scope checks for the final frontier and preserves cleanup", async () => {
		const firstMerge = "d".repeat(40);
		const secondMerge = "a".repeat(40);
		let fetches = 0;
		let refInventories = 0;
		let deleted = 0;
		let delegated = 0;
		const calls: string[] = [];
		const baseExec = exec(true, {
			"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
		});
		const finalExec: ExecFn = async (command, args, options) => {
			const key = `${command} ${args.join(" ")}`;
			calls.push(key);
			if (key === "git fetch origin") {
				fetches++;
				return { code: 0, stdout: "", stderr: "" };
			}
			if (key === "git rev-parse --verify refs/remotes/origin/main^{commit}") {
				return { code: 0, stdout: `${fetches > 1 ? secondMerge : firstMerge}\n`, stderr: "" };
			}
			if (key === "git for-each-ref --format=%(refname)%09%(objectname) refs/heads") {
				refInventories++;
			}
			return baseExec(command, args, options);
		};
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: finalExec,
				gateway: {
					...base,
					getPrStatus: async () => "merged",
					getMergeCommit: async (_repo, prNumber) => ({
						merged: true,
						mergeCommitOid: prNumber === 1 ? firstMerge : secondMerge,
						headCommitId: prNumber === 1 ? one : two,
						headRef: prNumber === 1 ? "kstack/one" : "kstack/two",
					}),
					getRemoteBranchSha: async (_repo, branch) => {
						if (branch === "kstack/one") return one;
						if (branch === "kstack/two") return two;
						return undefined;
					},
					deleteRemoteBranch: async () => {
						deleted++;
						return { kind: "deleted" as const };
					},
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => {
					delegated++;
					return { handled: false };
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "completed");
		assert.equal(delegated, 0);
		assert.equal(fetches, 2);
		assert.equal(refInventories, 4);
		assert.equal(calls.filter((call) => call.startsWith("git rebase --onto ")).length, 1);
		assert.ok(calls.includes("git switch main"));
		assert.equal(deleted, 2);
	});

	it("reports a post-merge scope inspection failure before rebase or publication", async () => {
		const scenario = await runInvalidPostRebaseScenario("late-inventory");
		assert.equal(scenario.result.status === "stack" ? scenario.result.outcome.status : "", "partial");
		assert.equal(
			scenario.calls.some((call) => call.startsWith("git rebase ")),
			false,
		);
		assert.equal(
			scenario.calls.some((call) => call.startsWith("git push ")),
			false,
		);
		assert.equal(
			scenario.calls.some((call) => call.startsWith("git branch -D ")),
			false,
		);
		assert.equal(scenario.baseUpdates, 0);
		assert.equal(scenario.navigationWrites, 0);
		assert.equal(scenario.remoteDeletes, 0);
		assert.deepEqual(
			scenario.result.status === "stack" && scenario.result.outcome.status === "partial"
				? scenario.result.outcome.recoveryOperationIds
				: [],
			[`kstack/two@${two}`],
		);
		assert.equal(
			scenario.result.status === "stack" && scenario.result.outcome.status === "partial"
				? scenario.result.outcome.frontiers[0]?.state
				: undefined,
			"already-merged",
		);
		assert.match(
			scenario.result.status === "stack" && scenario.result.outcome.status === "partial"
				? scenario.result.outcome.error
				: "",
			/inventory unavailable/,
		);
	});

	it("stops before publication when post-rebase refs or ancestry are invalid", async () => {
		for (const kind of ["added-ref", "moved-ref", "stale-ancestry"] as const) {
			const scenario = await runInvalidPostRebaseScenario(kind);
			assert.equal(scenario.result.status === "stack" ? scenario.result.outcome.status : "", "partial");
			assert.equal(
				scenario.calls.some((call) => call.startsWith("git push ")),
				false,
			);
			assert.equal(
				scenario.calls.some((call) => call.startsWith("git branch -D ")),
				false,
			);
			assert.equal(scenario.baseUpdates, 0);
			assert.equal(scenario.navigationWrites, 0);
			assert.equal(scenario.remoteDeletes, 0);
			assert.deepEqual(
				scenario.result.status === "stack" && scenario.result.outcome.status === "partial"
					? scenario.result.outcome.recoveryOperationIds
					: [],
				[`kstack/two@${two}`],
			);
			assert.ok(
				scenario.result.status === "stack" &&
					scenario.result.outcome.status === "partial" &&
					scenario.result.outcome.completedMutations.includes("Rebased stack remainder through kstack/two"),
			);
		}
	});

	it("preserves partial progress across conclusive and indeterminate publication checks", async () => {
		const mergeCommit = "d".repeat(40);
		for (const failure of ["push", "remote-inspection"] as const) {
			const calls: string[] = [];
			const pushCommand = `git push --atomic --force-with-lease=refs/heads/kstack/two:${two} origin ${two}:refs/heads/kstack/two`;
			const baseExec = exec(true, {
				"git fetch origin": {},
				"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
				"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${mergeCommit}\n` },
				[`git merge-base --is-ancestor ${mergeCommit} ${mergeCommit}`]: {},
				[pushCommand]: { code: 1, stderr: "remote rejected" },
			});
			const recordingExec: ExecFn = (command, args, options) => {
				calls.push(`${command} ${args.join(" ")}`);
				return baseExec(command, args, options);
			};
			let baseUpdates = 0;
			let navigationWrites = 0;
			let remoteDeletes = 0;
			const base = gateway();
			const result = await requestGitHubStackLanding(
				{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "check", method: "squash" },
				{
					exec: recordingExec,
					gateway: {
						...base,
						getPrStatus: async (_repo, prNumber) => (prNumber === 1 ? "merged" : "open"),
						getMergeCommit: async () => ({
							merged: true,
							mergeCommitOid: mergeCommit,
							headCommitId: one,
							headRef: "kstack/one",
						}),
						getRemoteBranchSha: async (_repo, branch) => {
							if (failure === "remote-inspection") {
								throw new GitHubError("remote acceptance unknown", "indeterminate");
							}
							return branch === "kstack/two" ? two : undefined;
						},
						updatePrBase: async () => {
							baseUpdates++;
						},
						createOrUpdateComment: async () => {
							navigationWrites++;
							return { id: 1 };
						},
						deleteRemoteBranch: async () => {
							remoteDeletes++;
							return { kind: "deleted" as const };
						},
					},
					confirm: async () => true,
					selectMethod: async () => "squash",
					landFrontier: async () => ({ handled: false }),
					acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
					realpath: (path) => path,
				},
			);
			assert.equal(result.status === "stack" ? result.outcome.status : "", "partial");
			assert.equal(calls.includes(pushCommand), failure === "push");
			assert.equal(baseUpdates, 0);
			assert.equal(navigationWrites, 0);
			assert.equal(remoteDeletes, 0);
			assert.ok(
				result.status === "stack" &&
					result.outcome.status === "partial" &&
					result.outcome.completedMutations.includes("Rebased stack remainder through kstack/two"),
			);
		}
	});

	it("records recovery handles when rebase and abort fail", async () => {
		const mergeCommit = "d".repeat(40);
		const base = gateway();
		const calls: string[] = [];
		const baseExec = exec(true, {
			"git fetch origin": {},
			"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
			"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${mergeCommit}\n` },
			[`git merge-base --is-ancestor ${mergeCommit} ${mergeCommit}`]: {},
			[`git rebase --onto refs/remotes/origin/main ${one} kstack/two --update-refs`]: {
				code: 1,
				stderr: "conflict",
			},
			"git rebase --abort": { code: 1, stderr: "abort failed" },
		});
		const recordingExec: ExecFn = (command, args, options) => {
			calls.push(`${command} ${args.join(" ")}`);
			return baseExec(command, args, options);
		};
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: recordingExec,
				gateway: {
					...base,
					getPrStatus: async (_repo, prNumber) => (prNumber === 1 ? "merged" : "open"),
					getMergeCommit: async () => ({
						merged: true,
						mergeCommitOid: mergeCommit,
						headCommitId: one,
						headRef: "kstack/one",
					}),
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({ handled: false }),
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "partial");
		assert.deepEqual(
			result.status === "stack" && result.outcome.status === "partial" ? result.outcome.recoveryOperationIds : [],
			[`kstack/two@${two}`],
		);
		assert.ok(calls.includes("git rebase --abort"));
		assert.equal(
			calls.some((call) => call.startsWith("git push ")),
			false,
		);
		assert.equal(
			calls.some((call) => call.startsWith("git branch -D ")),
			false,
		);
		assert.match(
			result.status === "stack" && result.outcome.status === "partial" ? result.outcome.error : "",
			/abort also failed: abort failed/,
		);
	});

	it("reports an indeterminate delegated frontier invocation", async () => {
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "watch", method: "squash" },
			{
				exec: exec(),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => {
					throw new GitHubError("frontier acceptance unknown", "indeterminate");
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "indeterminate");
		assert.match(
			result.status === "stack" && result.outcome.status === "indeterminate" ? result.outcome.inFlight : "",
			/frontier acceptance unknown/,
		);
	});

	it("preserves delegated cancellation before any mutation", async () => {
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "watch", method: "squash" },
			{
				exec: exec(),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({
					handled: true,
					outcome: {
						status: "aborted",
						frontiers: [],
						autopilotRan: false,
						remainingRefs: [],
						completedMutations: [],
						blockers: ["cancelled"],
					},
				}),
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "cancelled");
	});

	it("preserves an indeterminate delegated frontier outcome", async () => {
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "watch", method: "squash" },
			{
				exec: exec(),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({
					handled: true,
					outcome: {
						status: "indeterminate",
						frontiers: [],
						autopilotRan: true,
						remainingRefs: [],
						completedMutations: [],
						blockers: ["merge acceptance unknown"],
					},
				}),
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(result.status === "stack" ? result.outcome.status : "", "indeterminate");
	});

	it("uses Land's revised pin for verification, advancement, and cleanup", async () => {
		const revisedPin = "9".repeat(40);
		const mergeCommit = "d".repeat(40);
		const calls: string[] = [];
		let deletedBranch = "";
		const baseExec = exec(true, {
			"git fetch origin": {},
			"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
			"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${mergeCommit}\n` },
			[`git merge-base --is-ancestor ${mergeCommit} ${mergeCommit}`]: {},
		});
		const recordingExec: ExecFn = async (command, args, options) => {
			const key = `${command} ${args.join(" ")}`;
			calls.push(key);
			if (key === `git rev-list --reverse ${revisedPin}..${two}`) {
				return { code: 0, stdout: `${two}\n`, stderr: "" };
			}
			return baseExec(command, args, options);
		};
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 1, headRef: "kstack/one", readiness: "watch", method: "squash" },
			{
				exec: recordingExec,
				gateway: {
					...base,
					getMergeCommit: async () => ({
						merged: true,
						mergeCommitOid: mergeCommit,
						headCommitId: revisedPin,
						headRef: "kstack/one",
					}),
					getRemoteBranchSha: async (_repo, branch) => {
						if (branch === "kstack/one") return revisedPin;
						if (branch === "kstack/two") return two;
						return undefined;
					},
					deleteRemoteBranch: async (input) => {
						deletedBranch = input.branch;
						return { kind: "deleted" as const };
					},
				},
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async () => ({
					handled: true,
					outcome: {
						status: "landed",
						frontiers: [
							{
								prNumber: 1,
								url: "https://github.com/o/r/pull/1",
								expectedHeadSha: revisedPin,
								method: "squash",
								state: "landed",
							},
						],
						autopilotRan: true,
						remainingRefs: [],
						completedMutations: ["merged #1"],
						blockers: [],
					},
				}),
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.ok(result.status === "stack");
		assert.equal(result.outcome.status, "completed");
		assert.ok(calls.includes(`git rebase --onto refs/remotes/origin/main ${revisedPin} kstack/two --update-refs`));
		assert.equal(deletedBranch, "kstack/one");
	});

	it("delegates the exact pinned head and blocks cleanly when Land refuses it", async () => {
		let pinned = "";
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "watch", method: "squash" },
			{
				exec: exec(),
				gateway: gateway(),
				confirm: async () => true,
				selectMethod: async () => "squash",
				landFrontier: async (input) => {
					pinned = input.expectedHeadSha;
					return {
						handled: true,
						outcome: {
							status: "blocked",
							frontiers: [
								{
									prNumber: 1,
									url: "https://github.com/o/r/pull/1",
									expectedHeadSha: three,
									method: "squash",
									state: "blocked",
								},
							],
							autopilotRan: true,
							remainingRefs: [],
							completedMutations: [],
							warnings: [],
							blockers: ["not ready"],
						},
					};
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		);
		assert.equal(pinned, one);
		assert.ok(result.status === "stack");
		assert.ok(result.outcome.status === "partial");
		assert.equal(result.outcome.frontiers[0]?.expectedHeadSha, three);
	});
});
