/** Cross-provider stack mutation outcomes. */

import type { MergeMethod } from "../github.ts";

export interface StackBlocker {
	/** Provider-defined. Render across the seam; do not switch on it. */
	code: string;
	message: string;
	/** Slice ref the blocker concerns, when known. */
	ref?: string;
}

export interface StackPublishedPullRequest {
	ref: string;
	baseRef: string | null;
	prNumber: number;
	url: string;
	draft: boolean;
	changeIds?: readonly string[];
	headSha?: string;
}

const PR_METADATA_FOLLOW_UP =
	"Immediately rewrite each new draft's title and body with the write-pr skill, using the user's voice from the my-voice skill.";

export interface StackPublicationMap {
	topRef: string;
	pullRequests: readonly StackPublishedPullRequest[];
	remote?: string;
	repository?: { owner: string; repo: string };
	nativeStackNumber?: number;
}

export type CompletedPublicationAction =
	| { kind: "push-bookmark"; ref: string }
	| { kind: "create-draft-pr"; ref: string; prNumber: number; url: string }
	| { kind: "repair-pr-base"; ref: string; prNumber: number; targetBase: string }
	| { kind: "link-native-stack"; stackNumber: number; prNumbers: readonly number[] }
	| { kind: "create-nav-comment"; prNumber: number }
	| { kind: "update-nav-comment"; prNumber: number }
	| { kind: "mark-pr-ready"; ref: string; prNumber: number };

export type FailedPublicationAction = {
	kind: "push-bookmark" | "create-draft-pr" | "repair-pr-base" | "link-native-stack" | "nav-comment" | "mark-pr-ready";
	ref?: string;
	prNumber?: number;
	error: string;
};

export type StackPublishOutcome =
	| {
			status: "completed";
			planId: string;
			publication: StackPublicationMap;
			completedActions: readonly CompletedPublicationAction[];
			commentErrors?: readonly string[];
	  }
	| {
			status: "declined";
			planId?: string;
			blockers?: readonly StackBlocker[];
	  }
	| { status: "busy"; message: string }
	| { status: "blocked"; blockers: readonly StackBlocker[]; planId?: string }
	| { status: "stale"; providedPlanId: string; recomputedPlanId: string }
	| {
			status: "partial";
			planId: string;
			completedActions: readonly CompletedPublicationAction[];
			failedAction: FailedPublicationAction;
			commentErrors?: readonly string[];
			publication?: StackPublicationMap;
	  }
	| { status: "cancelled"; completedActions?: readonly CompletedPublicationAction[] }
	| {
			status: "indeterminate";
			planId?: string;
			inFlight: FailedPublicationAction;
			completedActions: readonly CompletedPublicationAction[];
			publication?: StackPublicationMap;
			recovery?: string;
	  }
	| { status: "failed"; error: string; completedActions?: readonly CompletedPublicationAction[] };

export function newlyCreatedDrafts(outcome: StackPublishOutcome): readonly StackPublishedPullRequest[] {
	if (outcome.status !== "completed" && outcome.status !== "partial" && outcome.status !== "indeterminate") return [];
	if (!outcome.publication) return [];
	const createdPrNumbers = new Set(
		outcome.completedActions.filter((action) => action.kind === "create-draft-pr").map((action) => action.prNumber),
	);
	return outcome.publication.pullRequests.filter((pr) => pr.draft && createdPrNumbers.has(pr.prNumber));
}

export function publicationMetadataFollowUp(outcome: StackPublishOutcome): string | undefined {
	return newlyCreatedDrafts(outcome).length > 0 ? PR_METADATA_FOLLOW_UP : undefined;
}

export interface StackLandFrontier {
	ref: string;
	prNumber: number;
	url: string;
	expectedHeadSha: string;
	method: MergeMethod | "graphite";
	state: "landed" | "queued" | "blocked" | "not-attempted" | "already-merged";
}

export interface StackLandProgress {
	frontiers: readonly StackLandFrontier[];
	remainingRefs: readonly string[];
	completedMutations: readonly string[];
	/** Non-fatal cleanup or reconciliation problems. */
	warnings: readonly string[];
	/** Provider-defined recovery handles. jj stores `jj op` ids. */
	recoveryOperationIds: readonly string[];
}

export function emptyStackLandProgress(): StackLandProgress {
	return { frontiers: [], remainingRefs: [], completedMutations: [], warnings: [], recoveryOperationIds: [] };
}

export type StackLandOutcome =
	| ({ status: "completed" } & StackLandProgress)
	| ({ status: "queued"; nativeStackNumber: number; submittedAt: string } & StackLandProgress)
	| ({ status: "partial"; error: string } & StackLandProgress)
	| { status: "blocked"; blockers: readonly StackBlocker[] }
	| { status: "declined" }
	| { status: "busy"; message: string }
	| ({ status: "cancelled" } & StackLandProgress)
	| ({ status: "indeterminate"; inFlight: string; recovery?: string } & StackLandProgress)
	| ({ status: "failed"; error: string } & StackLandProgress);

export type StackPrefixLandOutcome = { status: "not-stack" } | { status: "stack"; outcome: StackLandOutcome };
