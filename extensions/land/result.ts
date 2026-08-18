import type { LandResult } from "./types.ts";

export function blockedLandResult(reason: string): LandResult {
	return {
		status: "blocked",
		frontiers: [],
		autopilotRan: false,
		remainingBookmarks: [],
		completedMutations: [],
		warnings: [],
		blockers: [reason],
	};
}
