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
const existingPr: OpenPullRequest = {
	number: 12,
	headRef: "kstack/one",
	headCommitId: local,
	baseRef: "main",
	title: "One",
	draft: true,
	url: "https://github.com/o/r/pull/12",
	headOwner: "o",
};

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function publicationLockFixture(onRelease: () => void = () => {}) {
	let held = false;
	let releaseCount = 0;
	return {
		acquireLock: () => {
			if (held) {
				return { ok: false as const, holder: { pid: 123, startedAt: "2025-01-01T00:00:00.000Z" } };
			}
			held = true;
			return {
				ok: true as const,
				lock: {
					release: () => {
						assert.equal(held, true);
						held = false;
						releaseCount++;
						onRelease();
						return { ok: true as const };
					},
				},
			};
		},
		get held() {
			return held;
		},
		get releaseCount() {
			return releaseCount;
		},
	};
}

function execFixture(
	overrides: Record<string, { code?: number; stdout?: string; stderr?: string }> = {},
	fixtureOptions: { deferPush?: boolean; pushError?: Error } = {},
) {
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
	const pushStarted = deferred();
	const pushRelease = deferred();
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		if (command === "git" && args[0] === "push") {
			pushStarted.resolve();
			if (fixtureOptions.deferPush) await pushRelease.promise;
			if (fixtureOptions.pushError) throw fixtureOptions.pushError;
		}
		const result = overrides[key] ?? defaultResponses.get(key) ?? {};
		return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	return { exec, calls, pushStarted: pushStarted.promise, releasePush: pushRelease.resolve };
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
		createDraftPr: async () => existingPr,
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
		const existing = { ...existingPr, headCommitId: remoteHead };
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

	it("holds the publication lock through a deferred push and blocks a contender", async () => {
		const fixture = execFixture({}, { deferPush: true });
		const lock = publicationLockFixture();
		const firstPublication = publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec: fixture.exec,
				gateway: gateway(),
				confirm: async () => true,
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		try {
			await fixture.pushStarted;
			assert.equal(lock.held, true);
			assert.equal(lock.releaseCount, 0);

			const contender = await publishGitHubStack({
				cwd: "/repo",
				manifest,
				remote: "origin",
				ready: false,
				authorization: "model-tool",
				deps: {
					exec: execFixture().exec,
					gateway: gateway(),
					confirm: async () => true,
					acquireLock: lock.acquireLock,
					realpath: (path) => path,
				},
			});
			assert.equal(contender.status, "busy");
		} finally {
			fixture.releasePush();
			await firstPublication;
		}

		const firstOutcome = await firstPublication;
		assert.equal(firstOutcome.status, "completed");
		assert.equal(lock.held, false);
		assert.equal(lock.releaseCount, 1);
	});

	it("holds the publication lock through the final navigation comment write", async () => {
		const commentStarted = deferred();
		const commentRelease = deferred();
		const events: string[] = [];
		const lock = publicationLockFixture(() => events.push("lock-released"));
		const publication = publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec: execFixture().exec,
				gateway: gateway({
					createOrUpdateComment: async () => {
						events.push("comment-started");
						commentStarted.resolve();
						await commentRelease.promise;
						events.push("comment-finished");
						return { id: 1 };
					},
				}),
				confirm: async () => true,
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		try {
			await commentStarted.promise;
			assert.equal(lock.held, true);
			assert.equal(lock.releaseCount, 0);
			assert.deepEqual(events, ["comment-started"]);
		} finally {
			commentRelease.resolve();
			await publication;
		}

		const result = await publication;
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.deepEqual(result.completedActions, [
				{ kind: "push-bookmark", ref: "kstack/one" },
				{
					kind: "create-draft-pr",
					ref: "kstack/one",
					prNumber: 12,
					url: "https://github.com/o/r/pull/12",
				},
				{ kind: "create-nav-comment", prNumber: 12 },
			]);
		}
		assert.deepEqual(events, ["comment-started", "comment-finished", "lock-released"]);
		assert.equal(lock.held, false);
		assert.equal(lock.releaseCount, 1);
	});

	it("publishes core state and reports indeterminate comment writes without failing", async () => {
		const { exec, calls } = execFixture();
		const lock = publicationLockFixture();
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
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(result.status === "completed" ? result.commentErrors : [], ["comment acceptance unknown"]);
		assert.ok(calls.includes("git push origin kstack/one:refs/heads/kstack/one"));
		assert.equal(lock.releaseCount, 1);
	});

	it("releases the publication lock after a stale plan", async () => {
		const { exec, calls } = execFixture();
		const lock = publicationLockFixture();
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
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "stale");
		assert.equal(
			calls.some((call) => call.startsWith("git push ")),
			false,
		);
		assert.equal(lock.releaseCount, 1);
	});

	it("releases the publication lock after a declined confirmation", async () => {
		const { exec, calls } = execFixture();
		const lock = publicationLockFixture();
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
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "declined");
		assert.equal(confirmations, 1);
		assert.equal(
			calls.some((call) => call.startsWith("git push ")),
			false,
		);
		assert.equal(lock.releaseCount, 1);
	});

	it("releases the publication lock when confirmation rejects", async () => {
		const lock = publicationLockFixture();
		await assert.rejects(
			publishGitHubStack({
				cwd: "/repo",
				manifest,
				remote: "origin",
				ready: false,
				authorization: "interactive-confirmation",
				deps: {
					exec: execFixture().exec,
					gateway: gateway(),
					confirm: async () => {
						throw new Error("confirmation rejected");
					},
					acquireLock: lock.acquireLock,
					realpath: (path) => path,
				},
			}),
			/confirmation rejected/,
		);
		assert.equal(lock.held, false);
		assert.equal(lock.releaseCount, 1);
	});

	it("holds the publication lock until a conclusive push failure settles", async () => {
		const fixture = execFixture(
			{ "git push origin kstack/one:refs/heads/kstack/one": { code: 1, stderr: "rejected" } },
			{ deferPush: true },
		);
		const lock = publicationLockFixture();
		const publication = publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec: fixture.exec,
				gateway: gateway(),
				confirm: async () => true,
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		try {
			await fixture.pushStarted;
			assert.equal(lock.held, true);
			assert.equal(lock.releaseCount, 0);
		} finally {
			fixture.releasePush();
			await publication;
		}

		const result = await publication;
		assert.equal(result.status, "failed");
		assert.deepEqual(result.status === "failed" ? result.completedActions : undefined, []);
		assert.equal(lock.releaseCount, 1);
	});

	it("releases the publication lock after cancellation preserves completed progress", async () => {
		const controller = new AbortController();
		const fixture = execFixture();
		const lock = publicationLockFixture();
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
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		assert.equal(result.status, "partial");
		if (result.status === "partial") {
			assert.deepEqual(result.completedActions, [{ kind: "push-bookmark", ref: "kstack/one" }]);
			assert.equal(result.failedAction.kind, "create-draft-pr");
			assert.match(result.failedAction.error, /cancelled/i);
		}
		assert.equal(lock.releaseCount, 1);
	});

	it("holds the publication lock until an indeterminate push settles", async () => {
		const fixture = execFixture({}, { deferPush: true, pushError: new Error("connection dropped") });
		const lock = publicationLockFixture();
		const publication = publishGitHubStack({
			cwd: "/repo",
			manifest,
			remote: "origin",
			ready: false,
			authorization: "model-tool",
			deps: {
				exec: fixture.exec,
				gateway: gateway(),
				confirm: async () => true,
				acquireLock: lock.acquireLock,
				realpath: (path) => path,
			},
		});
		try {
			await fixture.pushStarted;
			assert.equal(lock.held, true);
			assert.equal(lock.releaseCount, 0);
		} finally {
			fixture.releasePush();
			await publication;
		}

		const result = await publication;
		assert.equal(result.status, "indeterminate");
		if (result.status === "indeterminate") {
			assert.deepEqual(result.completedActions, []);
			assert.equal(result.inFlight.kind, "push-bookmark");
			assert.match(result.recovery ?? "", /Inspect remote branches/);
		}
		assert.equal(lock.releaseCount, 1);
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
