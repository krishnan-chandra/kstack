/** Pure snapshot identity and publication-action planning. */

import { planIdFor } from "../shared/stack/plan-id.ts";
import { deriveSlices } from "./stack.ts";
import type {
	BookmarkTarget,
	CorePublicationAction,
	GitHubRepository,
	NativeMembership,
	OpenPullRequest,
	PublicationPlan,
	PublicationSlice,
	RemoteInfo,
	StackBlocker,
	StackCommit,
	StackSlice,
} from "./types.ts";

const PLAN_HASH_VERSION = 2;

export interface PublicationSnapshot {
	changeCount: number;
	repository: GitHubRepository;
	remote: RemoteInfo;
	defaultBranch: string;
	slices: readonly StackSlice[];
	localBookmarks: readonly BookmarkTarget[];
	remoteBookmarks: readonly BookmarkTarget[];
	openPrs: readonly OpenPullRequest[];
	nativeMembership: NativeMembership;
}

export function slicesForPublication(
	commits: readonly StackCommit[],
	topBookmark: string,
): { slices: StackSlice[] } | { blocker: StackBlocker } {
	const slices = deriveSlices(commits);
	if (slices.length === 0 || slices[slices.length - 1].bookmark !== topBookmark) {
		return {
			blocker: {
				code: "top-not-final-boundary",
				message: `Selected top bookmark ${JSON.stringify(topBookmark)} is not the final PR boundary.`,
			},
		};
	}
	return { slices };
}

export function buildPublicationPlan(snapshot: PublicationSnapshot): PublicationPlan {
	const slices: PublicationSlice[] = [];
	const actions: CorePublicationAction[] = [];
	const blockers: StackBlocker[] = [];
	let lastBookmark: string | null = null;

	for (const slice of snapshot.slices) {
		const targetBase = lastBookmark ?? snapshot.defaultBranch;
		const localMatches = snapshot.localBookmarks.filter((bookmark) => bookmark.name === slice.bookmark);
		const remoteMatches = snapshot.remoteBookmarks.filter((bookmark) => bookmark.name === slice.bookmark);
		if (localMatches.length !== 1) {
			blockers.push({
				code: "ambiguous-local-bookmark",
				message: `Bookmark ${JSON.stringify(slice.bookmark)} did not resolve to exactly one local target.`,
				ref: slice.bookmark,
			});
		}
		if (remoteMatches.length > 1) {
			blockers.push({
				code: "remote-bookmark-conflict",
				message: `Bookmark ${JSON.stringify(slice.bookmark)} is conflicted on remote ${JSON.stringify(snapshot.remote.name)}.`,
				ref: slice.bookmark,
			});
		}
		const localCommitId = localMatches.length === 1 ? localMatches[0].commitId : null;
		const remoteCommitId = remoteMatches.length === 1 ? remoteMatches[0].commitId : null;
		const matchingPrs = snapshot.openPrs.filter((pr) => pr.headRef === slice.bookmark);
		if (matchingPrs.length > 1) {
			blockers.push({
				code: "ambiguous-pr",
				message: `Multiple open PRs use bookmark ${JSON.stringify(slice.bookmark)}; refusing an ambiguous update.`,
				ref: slice.bookmark,
			});
		}
		const existingPr = matchingPrs.length === 1 ? matchingPrs[0] : undefined;
		const sliceActions: CorePublicationAction[] = [];
		if (localCommitId !== remoteCommitId && localCommitId !== null) {
			sliceActions.push({
				kind: "push-bookmark",
				bookmark: slice.bookmark,
				localCommitId,
				remoteCommitId,
			});
		}
		if (!existingPr) {
			sliceActions.push({
				kind: "create-draft-pr",
				bookmark: slice.bookmark,
				targetBase,
				provisionalTitle: slice.subject || slice.bookmark,
			});
		} else if (existingPr.baseRef && existingPr.baseRef !== targetBase) {
			sliceActions.push({
				kind: "repair-pr-base",
				bookmark: slice.bookmark,
				prNumber: existingPr.number,
				currentBase: existingPr.baseRef,
				targetBase,
			});
		}
		slices.push({
			bookmark: slice.bookmark,
			baseBookmark: slice.baseBookmark,
			changeIds: slice.changeIds,
			subject: slice.subject,
			targetBase,
			localCommitId,
			remoteCommitId,
			existingPr,
			actions: sliceActions,
		});
		actions.push(...sliceActions);
		lastBookmark = slice.bookmark;
	}

	if (snapshot.nativeMembership.kind === "diverged") {
		blockers.push({
			code: "native-stack-diverged",
			message: snapshot.nativeMembership.message,
		});
	}
	if (
		snapshot.nativeMembership.kind !== "none" &&
		actions.some((action) => action.kind === "repair-pr-base") &&
		actions.some((action) => action.kind === "push-bookmark")
	) {
		blockers.push({
			code: "native-stack-diverged",
			message: "Native stack base repair combined with rewritten heads is unsafe; rebuild the native stack explicitly.",
		});
	}

	if (!snapshot.remote.github) {
		blockers.push({
			code: "non-github-remote",
			message: `Remote ${JSON.stringify(snapshot.remote.name)} is not a GitHub repository.`,
		});
	}

	return {
		planId: computePlanId(snapshot, slices, actions),
		changeCount: snapshot.changeCount,
		repository: snapshot.repository,
		remote: snapshot.remote,
		defaultBranch: snapshot.defaultBranch,
		nativeMembership: snapshot.nativeMembership,
		slices,
		actions,
		blockers,
	};
}

function computePlanId(
	snapshot: PublicationSnapshot,
	slices: readonly PublicationSlice[],
	actions: readonly CorePublicationAction[],
): string {
	const canonical = {
		version: PLAN_HASH_VERSION,
		changeCount: snapshot.changeCount,
		repository: {
			owner: snapshot.repository.owner,
			repo: snapshot.repository.repo,
		},
		remote: {
			name: snapshot.remote.name,
			urlFingerprint: snapshot.remote.redactedUrl,
		},
		defaultBranch: snapshot.defaultBranch,
		nativeMembership:
			snapshot.nativeMembership.kind === "none"
				? { kind: snapshot.nativeMembership.kind }
				: {
						kind: snapshot.nativeMembership.kind,
						stackNumber: snapshot.nativeMembership.stackNumber ?? null,
						prNumbers: snapshot.nativeMembership.prNumbers,
						...(snapshot.nativeMembership.kind === "diverged"
							? { message: snapshot.nativeMembership.message }
							: undefined),
					},
		localBookmarks: snapshot.localBookmarks.map((bookmark) => ({
			name: bookmark.name,
			commitId: bookmark.commitId,
		})),
		remoteBookmarks: snapshot.remoteBookmarks.map((bookmark) => ({
			name: bookmark.name,
			commitId: bookmark.commitId,
		})),
		openPrs: snapshot.openPrs.map((pr) => ({
			number: pr.number,
			headRef: pr.headRef,
			headCommitId: pr.headCommitId,
			baseRef: pr.baseRef,
			draft: pr.draft,
		})),
		slices: slices.map((slice) => ({
			bookmark: slice.bookmark,
			baseBookmark: slice.baseBookmark,
			changeIds: slice.changeIds,
			subject: slice.subject,
			targetBase: slice.targetBase,
			localCommitId: slice.localCommitId,
			remoteCommitId: slice.remoteCommitId,
			existingPrNumber: slice.existingPr?.number ?? null,
			existingPrHeadCommitId: slice.existingPr?.headCommitId ?? null,
			existingPrBase: slice.existingPr?.baseRef ?? null,
			existingPrDraft: slice.existingPr?.draft ?? null,
		})),
		actions: actions.map((action) => ({ ...action })),
	};
	return planIdFor(1, canonical);
}
