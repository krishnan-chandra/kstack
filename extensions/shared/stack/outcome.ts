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

export interface StackPublicationMap {
	topRef: string;
	pullRequests: readonly StackPublishedPullRequest[];
	remote?: string;
	repository?: { owner: string; repo: string };
}

export type CompletedPublicationAction =
	| { kind: "push-bookmark"; ref: string }
	| { kind: "create-draft-pr"; ref: string; prNumber: number; url: string }
	| { kind: "repair-pr-base"; ref: string; prNumber: number; targetBase: string }
	| { kind: "create-nav-comment"; prNumber: number }
	| { kind: "update-nav-comment"; prNumber: number }
	| { kind: "mark-pr-ready"; ref: string; prNumber: number };

export type FailedPublicationAction = {
	kind: "push-bookmark" | "create-draft-pr" | "repair-pr-base" | "nav-comment" | "mark-pr-ready";
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
			recovery?: string;
	  }
	| { status: "failed"; error: string; completedActions?: readonly CompletedPublicationAction[] };

export interface StackLandFrontier {
	ref: string;
	prNumber: number;
	url: string;
	expectedHeadSha: string;
	method: MergeMethod;
	state: "landed" | "queued" | "blocked" | "not-attempted" | "already-merged";
}

interface StackLandProgress {
	frontiers: readonly StackLandFrontier[];
	remainingRefs: readonly string[];
	completedMutations: readonly string[];
	/** Non-fatal cleanup or reconciliation problems. */
	warnings?: readonly string[];
	/** Provider-defined recovery handles. jj stores `jj op` ids. */
	recoveryOperationIds: readonly string[];
}

export type StackLandOutcome =
	| ({ status: "completed" } & StackLandProgress)
	| ({ status: "partial"; error: string } & StackLandProgress)
	| { status: "blocked"; blockers: readonly StackBlocker[] }
	| { status: "declined" }
	| { status: "busy"; message: string }
	| {
			status: "cancelled";
			frontiers?: readonly StackLandFrontier[];
			completedMutations?: readonly string[];
			warnings?: readonly string[];
			recoveryOperationIds?: readonly string[];
	  }
	| ({ status: "indeterminate"; inFlight: string; recovery?: string } & StackLandProgress)
	| {
			status: "failed";
			error: string;
			frontiers?: readonly StackLandFrontier[];
			completedMutations?: readonly string[];
			warnings?: readonly string[];
			recoveryOperationIds?: readonly string[];
	  };

export type StackPrefixLandOutcome = { status: "not-stack" } | { status: "stack"; outcome: StackLandOutcome };
