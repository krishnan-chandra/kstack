import type { LandResult } from "../land/types.ts";
import type { GitHubAdapter } from "./github.ts";
import type { JjAdapter } from "./jj.ts";
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
		...overrides,
	};
	return adapter;
}

export function fakeGithub(overrides: Partial<GitHubAdapter> = {}): GitHubAdapter & { comments: string[] } {
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
			number: input.bookmark === "feat1" ? 11 : 12,
			headRef: input.bookmark,
			headCommitId: input.bookmark === "feat1" ? "aaa-commit" : "bbb-commit",
			baseRef: input.base,
			title: input.title,
			draft: true,
			url: `https://example/${input.bookmark}`,
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
		deleteRemoteBranch: async () => "deleted",
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
		remainingBookmarks: [],
		completedMutations: [`GitHub accepted merge/queue request for PR #${prNumber}`],
		blockers: [],
	};
}
