/** Shared accounting for publication actions and recoverable outcomes. */

import type {
	CompletedPublicationAction,
	FailedPublicationAction,
	StackPublicationMap,
	StackPublishedPullRequest,
	StackPublishOutcome,
} from "./outcome.ts";

type PartialOutcome = Extract<StackPublishOutcome, { status: "partial" }>;
type IndeterminateOutcome = Extract<StackPublishOutcome, { status: "indeterminate" }>;
type FailureOutcome = Extract<StackPublishOutcome, { status: "failed" }>;
type CancellationOutcome = Extract<StackPublishOutcome, { status: "cancelled" }>;

export function createPublicationProgress(input: {
	planId: string;
	topRef: string;
	remote?: string;
	repository?: { owner: string; repo: string };
	pullRequests(): readonly StackPublishedPullRequest[];
}) {
	const completedActions: CompletedPublicationAction[] = [];
	const publication = (): StackPublicationMap | undefined => {
		const pullRequests = input.pullRequests();
		if (pullRequests.length === 0) return undefined;
		const map: StackPublicationMap = {
			topRef: pullRequests.at(-1)?.ref ?? input.topRef,
			pullRequests,
		};
		if (input.remote !== undefined) map.remote = input.remote;
		if (input.repository !== undefined) map.repository = input.repository;
		return map;
	};
	const partial = (failedAction: FailedPublicationAction): PartialOutcome => ({
		status: "partial",
		planId: input.planId,
		completedActions,
		publication: publication(),
		failedAction,
	});

	return {
		completed(action: CompletedPublicationAction): void {
			completedActions.push(action);
		},
		completedActions(): readonly CompletedPublicationAction[] {
			return completedActions;
		},
		publication,
		cancelled(failedAction: FailedPublicationAction): CancellationOutcome | PartialOutcome {
			return completedActions.length === 0 ? { status: "cancelled" } : partial(failedAction);
		},
		failed(failedAction: FailedPublicationAction): FailureOutcome | PartialOutcome {
			if (completedActions.length === 0) {
				return { status: "failed", error: failedAction.error, completedActions };
			}
			return partial(failedAction);
		},
		partial,
		indeterminate(failedAction: FailedPublicationAction, recovery: string): IndeterminateOutcome {
			return {
				status: "indeterminate",
				planId: input.planId,
				inFlight: failedAction,
				completedActions,
				publication: publication(),
				recovery,
			};
		},
	};
}
