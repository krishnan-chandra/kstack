import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { GitHubError, type GitHubGateway, type OpenPullRequest } from "../shared/github.ts";
import { buildNavigationComment } from "../shared/stack/topology.ts";
import { requestGitHubStackLanding } from "./landing.ts";

const one = "b".repeat(40);
const two = "c".repeat(40);
const three = "e".repeat(40);
const entries = [
	{ prNumber: 1, bookmark: "kstack/one", base: "main", status: "open" as const },
	{ prNumber: 2, bookmark: "kstack/two", base: "kstack/one", status: "open" as const },
];

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
		deleteRemoteBranch: async () => "deleted",
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
		} satisfies Record<string, { code?: number; stdout?: string; stderr?: string }>;
		const responses = new Map<string, { code?: number; stdout?: string; stderr?: string }>(Object.entries(values));
		const value = overrides[key] ?? responses.get(key) ?? {};
		return { code: value.code ?? 0, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
	};
}

describe("GitHub stack landing", () => {
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
		assert.match(pushes[0], /kstack\/two:refs\/heads\/kstack\/two/);
		assert.match(pushes[0], /kstack\/three:refs\/heads\/kstack\/three/);
	});

	it("records recovery handles before a conflicted advance", async () => {
		const mergeCommit = "d".repeat(40);
		const base = gateway();
		const result = await requestGitHubStackLanding(
			{ cwd: "/repo", prNumber: 2, headRef: "kstack/two", readiness: "check", method: "squash" },
			{
				exec: exec(true, {
					"git fetch origin": {},
					"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
					"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${mergeCommit}\n` },
					[`git merge-base --is-ancestor ${mergeCommit} ${mergeCommit}`]: {},
					[`git rebase --onto refs/remotes/origin/main ${one} kstack/two --update-refs`]: {
						code: 1,
						stderr: "conflict",
					},
					"git rebase --abort": {},
				}),
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
			calls.push(`${command} ${args.join(" ")}`);
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
					deleteRemoteBranch: async (_repo, branch) => {
						deletedBranch = branch;
						return "deleted";
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
