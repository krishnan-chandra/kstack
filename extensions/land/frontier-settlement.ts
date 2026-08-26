/** Provider-neutral application of a delegated stack-frontier LandResult. */
import type { RequestResponse } from "../shared/request-channel.ts";
import type { StackLandFrontier, StackLandOutcome, StackLandProgress } from "../shared/stack/outcome.ts";
import type { LandResult } from "./types.ts";

export type DelegatedFrontierResponse = RequestResponse<LandResult>;

type AppliedDelegatedFrontier =
	| {
			kind: "landed";
			frontier: StackLandFrontier;
			newCompletedMutations: readonly string[];
	  }
	| { kind: "halted"; outcome: StackLandOutcome };

/**
 * Applies Land's response to one provider frontier and its accumulated progress.
 * A returned head pin is adopted only from the frontier matching the requested PR.
 */
export function applyDelegatedFrontierSettlement(input: {
	response: DelegatedFrontierResponse;
	frontier: StackLandFrontier;
	progress: StackLandProgress;
}): AppliedDelegatedFrontier {
	const { frontier, progress, response } = input;
	if (!response.handled) {
		if (progress.frontiers.length === 0 && progress.completedMutations.length === 0) {
			return {
				kind: "halted",
				outcome: {
					status: "blocked",
					blockers: [{ code: "land-unavailable", message: "The land extension is unavailable." }],
				},
			};
		}
		return {
			kind: "halted",
			outcome: {
				status: "partial",
				error: "The land extension is unavailable.",
				...progress,
				frontiers: [...progress.frontiers, frontier],
			},
		};
	}

	const { outcome } = response;
	const matchingFrontier = outcome.frontiers.find((candidate) => candidate.prNumber === frontier.prNumber);
	const settledFrontier = {
		...frontier,
		expectedHeadSha: matchingFrontier?.expectedHeadSha ?? frontier.expectedHeadSha,
	};
	if (outcome.status === "landed") {
		return {
			kind: "landed",
			frontier: { ...settledFrontier, state: "landed" },
			newCompletedMutations: outcome.completedMutations,
		};
	}

	const completedMutations = [...progress.completedMutations, ...outcome.completedMutations];
	const error = outcome.blockers.join(" ") || `Land returned ${outcome.status}.`;
	const frontierState: StackLandFrontier["state"] = outcome.status === "partially-landed" ? "queued" : "blocked";
	const haltedProgress = {
		...progress,
		frontiers: [...progress.frontiers, { ...settledFrontier, state: frontierState }],
		completedMutations,
	};
	const hasMutations = completedMutations.length > 0;
	if (outcome.status === "indeterminate") {
		return { kind: "halted", outcome: { status: "indeterminate", inFlight: error, ...haltedProgress } };
	}
	if ((outcome.status === "aborted" || outcome.status === "declined") && !hasMutations) {
		return { kind: "halted", outcome: { status: "cancelled", ...haltedProgress } };
	}
	if (outcome.status === "failed" && !hasMutations) {
		return { kind: "halted", outcome: { status: "failed", error, ...haltedProgress } };
	}
	return { kind: "halted", outcome: { status: "partial", error, ...haltedProgress } };
}
