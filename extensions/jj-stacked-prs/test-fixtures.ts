import type { LandResult } from "../land/types.ts";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import type { GitHubGateway } from "../shared/github.ts";
import type { LockAttempt } from "../shared/publication-lock.ts";
import type { JjAdapter } from "./jj.ts";
import type { NativeStackGateway } from "./native-stack.ts";
import type { OpenPullRequest, RemoteInfo, StackCommit } from "./types.ts";

export function commit(changeId: string, bookmark: string, parent = "trunk"): StackCommit {
	return {
		changeId,
		commitId: `${changeId}-commit`,
		subject: `feat: ${changeId}`,
		bookmarks: [bookmark],
		remoteBookmarks: [],
		parentCommitIds: [parent],
		empty: false,
		conflict: false,
		divergent: false,
		merge: false,
		workingCopy: false,
	};
}

function remote(): RemoteInfo {
	return {
		name: "origin",
		url: "https://github.com/o/r.git",
		redactedUrl: "https://github.com/o/r.git",
		github: { owner: "o", repo: "r" },
	};
}

export function fakeJj(overrides: Partial<JjAdapter> = {}): JjAdapter & { calls: string[] } {
	const calls: string[] = [];
	const adapter: JjAdapter & { calls: string[] } = {
		calls,
		preflight: async () => ({ workspaceRoot: "/repo", jjVersion: "jj 0.44.0" }),
		resolveRevset: async (_cwd, revset) => (revset === "trunk()" ? "trunk" : `${revset}-id`),
		workingCopyChangeId: async () => undefined,
		workingCopyStatus: async () => undefined,
		rebaseWorkingCopy: async (_cwd, revision) => {
			calls.push(`rebase-wc:${revision}`);
		},
		listLocalBookmarks: async () => [
			{ name: "feat1", commitId: "aaa-commit" },
			{ name: "feat2", commitId: "bbb-commit" },
		],
		listRemoteBookmarks: async () => [],
		fetchStack: async () => [commit("aaa", "feat1"), commit("bbb", "feat2")],
		listRemotes: async () => [remote()],
		getRemote: async () => remote(),
		currentOperationId: async () => "op1",
		pushBookmark: async (_cwd, _remote, bookmark) => {
			calls.push(`push:${bookmark}`);
		},
		fetchRemote: async () => {
			calls.push("fetch");
		},
		rebaseStack: async () => {
			calls.push("rebase");
		},
		abandonRange: async (_cwd, trunk, merged) => {
			calls.push(`abandon:${trunk}..${merged}`);
		},
		isAncestor: async () => true,
		areAncestors: async (_cwd, ancestors) => ancestors.map(() => true),
		...overrides,
	};
	return adapter;
}

export function fakeGithub(overrides: Partial<GitHubGateway> = {}): GitHubGateway & { comments: string[] } {
	const comments: string[] = [];
	return {
		comments,
		getDefaultBranch: async () => "main",
		listOpenPrs: async () => [],
		listPrsForHead: async (_repo, head) => {
			const listed = overrides.listOpenPrs ? await overrides.listOpenPrs({ owner: "o", repo: "r" }, "/repo") : [];
			return listed.filter((pr) => pr.headRef === head);
		},
		getAuthenticatedUser: async () => "publisher",
		getPrStatus: async () => "open",
		getPrComments: async () => [],
		createDraftPr: async (input) => ({
			number: input.ref === "feat1" ? 11 : 12,
			headRef: input.ref,
			headCommitId: input.ref === "feat1" ? "aaa-commit" : "bbb-commit",
			baseRef: input.base,
			title: input.title,
			draft: true,
			url: `https://example/${input.ref}`,
			headOwner: "o",
		}),
		updatePrBase: async () => {},
		createOrUpdateComment: async (input) => {
			comments.push(input.body);
			return { id: 1 };
		},
		getMergeCommit: async (_repo, prNumber) => ({
			merged: true,
			mergeCommitOid: `merge-${prNumber}`,
			headCommitId: prNumber === 11 ? "aaa-commit" : "bbb-commit",
			headRef: prNumber === 11 ? "feat1" : "feat2",
		}),
		getAllowedMergeMethods: async () => ["squash"],
		getRemoteBranchSha: async (_repo, branch) => (branch === "feat2" ? "bbb-commit" : "aaa-commit"),
		markPrReady: async () => {},
		deleteRemoteBranch: async () => ({ kind: "deleted" as const }),
		...overrides,
	};
}

export function fakeNativeStack(overrides: Partial<NativeStackGateway> = {}): NativeStackGateway {
	return {
		preflight: async () => ({ status: "available", version: "0.1.0" }),
		baseUsesMergeQueue: async () => false,
		inspectForPullRequest: async () => undefined,
		link: async ({ base, prNumbers }) => ({
			stackNumber: 17,
			baseRef: base,
			open: true,
			pullRequests: prNumbers.map((number, index) => ({
				number,
				state: "open",
				draft: true,
				head: { ref: `feat${index + 1}`, sha: `${String.fromCharCode(97 + index).repeat(3)}-commit` },
			})),
		}),
		mergeThrough: async () => {
			throw new Error("Unexpected native merge submission");
		},
		...overrides,
	};
}

export function ui(overrides: { confirm?: boolean; hasUI?: boolean; select?: string } = {}) {
	return {
		hasUI: overrides.hasUI ?? true,
		confirm: async () => overrides.confirm ?? true,
		select: async () => overrides.select,
		notify: () => {},
		setStatus: () => {},
	};
}

export function openPrs(): OpenPullRequest[] {
	return [
		{
			number: 11,
			headRef: "feat1",
			headCommitId: "aaa-commit",
			baseRef: "main",
			title: "one",
			draft: true,
			url: "https://example/11",
			headOwner: "o",
		},
		{
			number: 12,
			headRef: "feat2",
			headCommitId: "bbb-commit",
			baseRef: "feat1",
			title: "two",
			draft: false,
			url: "https://example/12",
			headOwner: "o",
		},
	];
}

/** A no-op lock that always succeeds and never touches the filesystem. */
export function permissiveLock(): (repositoryPath: string) => LockAttempt {
	return () => ({
		ok: true,
		lock: {
			release() {
				return { ok: true };
			},
		},
	});
}

export function readyPr(prNumber: number, headSha: string, headRef: string): AutopilotResult {
	return {
		status: "merge-ready",
		mergeReady: true,
		cyclesCompleted: 1,
		blockedReasons: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		prState: {
			number: prNumber,
			title: headRef,
			state: "open",
			isDraft: false,
			headSha,
			verifiedHeadSha: headSha,
			baseRef: prNumber === 11 ? "main" : "feat1",
			headRef,
			mergeable: "mergeable",
			mergeStateStatus: "CLEAN",
			checks: [],
			threads: [],
			hasUnresolvedThreads: false,
		},
	};
}

export function landed(prNumber: number, sha: string): LandResult {
	return {
		status: "landed",
		frontiers: [
			{
				prNumber,
				url: `https://example/${prNumber}`,
				expectedHeadSha: sha,
				method: "squash",
				state: "landed",
			},
		],
		autopilotRan: true,
		remainingRefs: [],
		completedMutations: [`GitHub accepted merge/queue request for PR #${prNumber}`],
		blockers: [],
	};
}
