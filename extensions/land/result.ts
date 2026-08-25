import type { LandResult } from "./types.ts";

export function blockedLandResult(reason: string): LandResult {
	return {
		status: "blocked",
		frontiers: [],
		autopilotRan: false,
		remainingRefs: [],
		completedMutations: [],
		warnings: [],
		blockers: [reason],
	};
}
