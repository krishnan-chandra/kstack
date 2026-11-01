import type { VcsBackendId } from "./config.ts";

/** Every user-facing and child-facing per-backend wording in one place. */
interface VcsPolicy {
	readonly id: VcsBackendId;
	readonly workstreamNoun: string;
	readonly baseUpdateVerb: "merge" | "restack";
	/** Inspection-only VCS instructions for a child that hands edits back to the parent. */
	readonly childGuidance: string;
	/** How a remote base ref is displayed, e.g. origin/main vs main@origin. */
	remoteBaseDisplay(baseRef: string): string;
	readonly baseUpdateDisclosure: string;
	readonly fixPublicationDisclosure: string;
	readonly conflictRuleSuffix: string;
	readonly cleanupCompleteNotice: string;
}

const gitChildGuidance = [
	"VCS backend: git.",
	"Use Git only to inspect state, such as git status, git diff, and git log. Do not run jj commands.",
	"Leave every edit uncommitted in the working tree. The parent records and pushes it.",
].join(" ");

const jjChildGuidance = [
	"VCS backend: jj.",
	"Use jj only to inspect state, such as jj status, jj diff, and jj log. Do not run git commands.",
	"Leave every edit in the current working-copy change. Do not describe, commit, squash, or move bookmarks. The parent records and pushes it.",
].join(" ");

const graphiteChildGuidance = [
	"VCS backend: Graphite.",
	"Use git or gt only to inspect state, such as git status, git diff, and gt log.",
	"Leave every edit uncommitted in the working tree. Do not stage, commit, restack, or submit. The parent records and submits it.",
].join(" ");

const standardCleanupNotice = "PR autopilot cleanup complete. Managed worktree removed; session archive is manual.";

export function vcsPolicy(id: VcsBackendId): VcsPolicy {
	switch (id) {
		case "git":
			return {
				id,
				workstreamNoun: "Git checkout",
				baseUpdateVerb: "merge",
				childGuidance: gitChildGuidance,
				remoteBaseDisplay: (baseRef) => `origin/${baseRef}`,
				baseUpdateDisclosure: "No rebase is performed.",
				fixPublicationDisclosure: "The autopilot will NOT rebase, restack, merge the PR, or touch merge settings.",
				conflictRuleSuffix: " (never rebase)",
				cleanupCompleteNotice: standardCleanupNotice,
			};
		case "jj":
			return {
				id,
				workstreamNoun: "jj workspace",
				baseUpdateVerb: "merge",
				childGuidance: jjChildGuidance,
				remoteBaseDisplay: (baseRef) => `${baseRef}@origin`,
				baseUpdateDisclosure: "No rebase is performed.",
				fixPublicationDisclosure: "The autopilot will NOT rebase, restack, merge the PR, or touch merge settings.",
				conflictRuleSuffix: " (never rebase)",
				cleanupCompleteNotice: "PR autopilot cleanup complete. jj mode has no managed Git worktree to remove.",
			};
		case "graphite":
			return {
				id,
				workstreamNoun: "Graphite checkout",
				baseUpdateVerb: "restack",
				childGuidance: graphiteChildGuidance,
				remoteBaseDisplay: (baseRef) => `origin/${baseRef}`,
				baseUpdateDisclosure: "A restack can rewrite this branch; Kstack proved it currently has no local descendants.",
				fixPublicationDisclosure:
					"Graphite may rewrite the selected branch; Kstack rechecks that it has no descendants immediately before recording. It will not merge the PR or change merge settings.",
				conflictRuleSuffix: "; Graphite mutations proceed only when no local descendants exist",
				cleanupCompleteNotice: standardCleanupNotice,
			};
		default: {
			const _exhaustive: never = id;
			return _exhaustive;
		}
	}
}
