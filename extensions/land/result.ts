import type { LandResult } from "./types.ts";

export function abortedLandResult(reason = "Landing was cancelled."): LandResult {
	return {
		status: "aborted",
		frontiers: [],
		remainingRefs: [],
		completedMutations: [],
		warnings: [],
		blockers: [reason],
	};
}

export function blockedLandResult(reason: string): LandResult {
	return {
		status: "blocked",
		frontiers: [],
		remainingRefs: [],
		completedMutations: [],
		warnings: [],
		blockers: [reason],
	};
}
