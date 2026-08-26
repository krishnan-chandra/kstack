import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { GitHubError, type GitHubGateway, type OpenPullRequest } from "../shared/github.ts";
import type { VerifiedStackManifest } from "../shared/stack/manifest.ts";
import { planGitHubPublication, preflightGitHubStack, publishGitHubStack } from "./delivery.ts";

const trunk = "a".repeat(40);
const local = "b".repeat(40);
const remoteHead = "c".repeat(40);
const manifest = {
	schemaVersion: 1 as const,
	trunkRef: "refs/remotes/origin/main",
	trunkSha: trunk,
	slices: [{ branch: "kstack/one", baseBranch: "refs/remotes/origin/main", headSha: local, subject: "One" }],
};

function execFixture(overrides: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
	const calls: string[] = [];
	const defaults = {
		"git rev-parse --show-toplevel": { stdout: "/repo\n" },
		"git status --porcelain=v1 --untracked-files=all": {},
		"git branch --show-current": { stdout: "kstack/one\n" },
		"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${trunk}\n` },
		"git check-ref-format --branch kstack/one": {},
		"git rev-parse --verify refs/heads/kstack/one^{commit}": { stdout: `${local}\n` },
		[`git merge-base --is-ancestor ${trunk} ${local}`]: {},
		[`git diff --quiet ${trunk} ${local} --`]: { code: 1 },
		"git remote get-url origin": { stdout: "https://github.com/o/r.git\n" },
		"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
		"git push origin kstack/one:refs/heads/kstack/one": {},
	} satisfies Record<string, { code?: number; stdout?: string; stderr?: string }>;
	const defaultResponses = new Map<string, { code?: number; stdout?: string; stderr?: string }>(
		Object.entries(defaults),
	);
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		const result = overrides[key] ?? defaultResponses.get(key) ?? {};
		return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	return { exec, calls };
}

function gateway(overrides: Partial<GitHubGateway> = {}): GitHubGateway {
	const base = {
		getDefaultBranch: async () => "main",
		listOpenPrs: async () => [],
		listPrsForHead: async () => [],
		getAuthenticatedUser: async () => "me",
		getPrStatus: async () => "open" as const,
		getPrComments: async () => [],
		getMergeCommit: async () => ({
			merged: false,
			mergeCommitOid: undefined,
			headCommitId: local,
			headRef: "kstack/one",
		}),
		getAllowedMergeMethods: async () => ["squash" as const],
		getRemoteBranchSha: async () => undefined,
		markPrReady: async () => {},
		deleteRemoteBranch: async () => "deleted" as const,
		createDraftPr: async () => ({
			number: 12,
			headRef: "kstack/one",
			headCommitId: local,
			baseRef: "main",
			title: "One",
			draft: true,
			url: "https://github.com/o/r/pull/12",
			headOwner: "o",
		}),
		updatePrBase: async () => {},
		createOrUpdateComment: async () => ({ id: 1 }),
	} satisfies GitHubGateway;
	return { ...base, ...overrides };
}

describe("GitHub stack publication", () => {
	it("blocks a dirty tree during stack preflight", async () => {
		const { exec } = execFixture({
			"git --version": { stdout: "git version 2.38.0\n" },
			"git status --porcelain=v1 --untracked-files=all": { stdout: " M existing.ts\n" },
		});
		const result = await preflightGitHubStack("/repo", "/tmp/manifest.json", exec, gateway());
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /clean working tree/);
	});

	it("fetches and pins the remote-tracking trunk during preflight", async () => {
		const { exec, calls } = execFixture({
			"git --version": { stdout: "git version 2.38.0\n" },
			"git symbolic-ref refs/remotes/origin/HEAD": { code: 1 },
			"git fetch origin +refs/heads/main:refs/remotes/origin/main": {},
		});
		const result = await preflightGitHubStack("/repo", "/tmp/manifest.json", exec, gateway());
		assert.equal(result.ok, true);
		assert.ok(calls.includes("git fetch origin +refs/heads/main:refs/remotes/origin/main"));
		assert.equal(result.ok ? result.trunkRef : "", "refs/remotes/origin/main");
	});

	it("plans an exact leased republish for an existing PR", async () => {
		const existing: OpenPullRequest = {
			number: 12,
			headRef: "kstack/one",
			headCommitId: remoteHead,
			baseRef: "main",
			title: "One",
			draft: true,
			url: "https://github.com/o/r/pull/12",
			headOwner: "o",
		};
		const { exec } = execFixture();
		const stack: VerifiedStackManifest = { repositoryRoot: "/repo", manifest };
		const planned = await planGitHubPublication({
			stack,
			remote: "origin",
			ready: false,
			exec,
			gateway: gateway({ listOpenPrs: async () => [existing], getRemoteBranchSha: async () => remoteHead }),
		});
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		assert.deepEqual(planned.plan.slices[0].actions[0], {
			kind: "push-bookmark",
			ref: "kstack/one",
			headSha: local,
			expectedRemoteSha: remoteHead,
		});
	});

	it("publishes core state and reports indeterminate comment writes without failing", async () => {
		const { exec, calls } = execFixture();
		const result = await publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec,
				gateway: gateway({
					createOrUpdateComment: async () => {
						throw new GitHubError("comment acceptance unknown", "indeterminate");
					},
				}),
				confirm: async () => true,
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(result.status === "completed" ? result.commentErrors : [], ["comment acceptance unknown"]);
		assert.ok(calls.includes("git push origin kstack/one:refs/heads/kstack/one"));
	});

	it("returns stale when remote state changes under the lock", async () => {
		const { exec, calls } = execFixture();
		let reads = 0;
		const result = await publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec,
				gateway: gateway({ getRemoteBranchSha: async () => (++reads === 1 ? undefined : remoteHead) }),
				confirm: async () => true,
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "stale");
		assert.equal(
			calls.some((call) => call.startsWith("git push ")),
			false,
		);
	});

	it("declines once without applying the confirmed plan", async () => {
		const { exec, calls } = execFixture();
		let confirmations = 0;
		const result = await publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "interactive-confirmation",
			deps: {
				exec,
				gateway: gateway(),
				confirm: async () => {
					confirmations++;
					return false;
				},
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "declined");
		assert.equal(confirmations, 1);
		assert.equal(
			calls.some((call) => call.startsWith("git push ")),
			false,
		);
	});

	it("reports a conclusive first action failure as failed", async () => {
		const { exec } = execFixture();
		const result = await publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec,
				gateway: gateway({
					getRemoteBranchSha: async () => local,
					createDraftPr: async () => {
						throw new Error("creation rejected");
					},
				}),
				confirm: async () => true,
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "failed");
		assert.deepEqual(result.status === "failed" ? result.completedActions : undefined, []);
	});

	it("reports cancellation between actions as partial progress", async () => {
		const controller = new AbortController();
		const fixture = execFixture();
		const abortAfterPush: ExecFn = async (command, args, options) => {
			const result = await fixture.exec(command, args, options);
			if (command === "git" && args[0] === "push") controller.abort();
			return result;
		};
		const result = await publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec: abortAfterPush,
				gateway: gateway(),
				confirm: async () => true,
				signal: controller.signal,
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "partial");
		if (result.status === "partial") {
			assert.deepEqual(result.completedActions, [{ kind: "push-bookmark", ref: "kstack/one" }]);
			assert.equal(result.failedAction.kind, "create-draft-pr");
			assert.match(result.failedAction.error, /cancelled/i);
		}
	});

	it("reports an indeterminate push when the process ends without a result", async () => {
		const fixture = execFixture();
		const uncertainExec: ExecFn = async (command, args, options) => {
			if (command === "git" && args[0] === "push") throw new Error("connection dropped");
			return fixture.exec(command, args, options);
		};
		const result = await publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec: uncertainExec,
				gateway: gateway(),
				confirm: async () => true,
				acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "indeterminate");
		assert.match(result.status === "indeterminate" ? (result.recovery ?? "") : "", /Inspect remote branches/);
	});

	it("blocks before mutation when trunk moved", async () => {
		const { exec, calls } = execFixture({
			"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${remoteHead}\n` },
		});
		const result = await publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: { exec, gateway: gateway(), confirm: async () => true },
		});
		assert.equal(result.status, "blocked");
		assert.equal(
			calls.some((call) => call.startsWith("git push ")),
			false,
		);
	});
});
