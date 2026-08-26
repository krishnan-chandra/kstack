import type { VcsBackendId } from "./config.ts";

/** Every user-facing and child-facing per-backend wording in one place. */
interface VcsPolicy {
	readonly id: VcsBackendId;
	readonly refNoun: string;
	readonly workstreamNoun: string;
	readonly baseUpdateVerb: "merge" | "restack";
	/** Mutually exclusive child-agent VCS instructions. */
	readonly childGuidance: string;
	/** How a remote base ref is displayed, e.g. origin/main vs main@origin. */
	remoteBaseDisplay(baseRef: string): string;
	readonly baseUpdateDisclosure: string;
	readonly fixPublicationDisclosure: string;
	readonly conflictRuleSuffix: string;
	readonly taskWorkstreamSummary: string;
	readonly approvalSummary: string;
	readonly currentWorkspaceLabel: string;
	readonly currentModeDisclosure: string;
	readonly cleanupCompleteNotice: string;
}

const gitChildGuidance = [
	"VCS backend: git.",
	"Use Git for all version-control state and mutations. Do not run jj commands.",
	"For single delivery, work only on the branch or worktree prepared by the parent. A stack policy may instead authorize the named local branches. Make incremental Git commits and leave the working tree clean.",
].join(" ");

const jjChildGuidance = [
	"VCS backend: jj.",
	"Use jj for all version-control state and mutations. Do not run git status, add, commit, checkout, switch, merge, rebase, restore, or push.",
	"Inspect with jj status/diff/log. Record work with jj describe, jj commit, or jj new as appropriate, and keep the task bookmark on the change intended for publication.",
	"Do not create Git branches or worktrees. Leave an empty jj working-copy commit after recording the implementation.",
].join(" ");

const graphiteChildGuidance = [
	"VCS backend: Graphite.",
	"Use gt for branch, staging, commit, restore, checkout, and restack mutations. Do not run git commit, branch, rebase, or push.",
	"Use read-only Git inspection when needed. The parent alone submits or lands work unless a later prompt explicitly authorizes publication.",
].join(" ");

const standardCurrentModeDisclosure =
	"Current-mode implementation requires a clean working tree, creates a dedicated kstack/<task-slug> branch, and commits verified increments. If this checkout is dirty, stop and rerun with --worktree. ";
const standardCleanupNotice = "PR autopilot cleanup complete. Managed worktree removed; session archive is manual.";

export function vcsPolicy(id: VcsBackendId): VcsPolicy {
	switch (id) {
		case "git":
			return {
				id,
				refNoun: "branch",
				workstreamNoun: "Git checkout",
				baseUpdateVerb: "merge",
				childGuidance: gitChildGuidance,
				remoteBaseDisplay: (baseRef) => `origin/${baseRef}`,
				baseUpdateDisclosure: "No rebase is performed.",
				fixPublicationDisclosure: "The autopilot will NOT rebase, restack, merge the PR, or touch merge settings.",
				conflictRuleSuffix: " (never rebase)",
				taskWorkstreamSummary: "creates a dedicated branch and incremental Git commits",
				approvalSummary: "creates a dedicated branch and incremental local commits",
				currentWorkspaceLabel: "current Git checkout",
				currentModeDisclosure: standardCurrentModeDisclosure,
				cleanupCompleteNotice: standardCleanupNotice,
			};
		case "jj":
			return {
				id,
				refNoun: "bookmark",
				workstreamNoun: "jj workspace",
				baseUpdateVerb: "merge",
				childGuidance: jjChildGuidance,
				remoteBaseDisplay: (baseRef) => `${baseRef}@origin`,
				baseUpdateDisclosure: "No rebase is performed.",
				fixPublicationDisclosure: "The autopilot will NOT rebase, restack, merge the PR, or touch merge settings.",
				conflictRuleSuffix: " (never rebase)",
				taskWorkstreamSummary: "creates a dedicated jj change and task bookmark",
				approvalSummary: "creates a trunk-based jj change and task bookmark",
				currentWorkspaceLabel: "current jj workspace",
				currentModeDisclosure:
					"The parent creates a trunk()-based jj change and task bookmark after plan approval. jj snapshots the current workspace state, so Git dirty-tree rules do not apply. ",
				cleanupCompleteNotice: "PR autopilot cleanup complete. jj mode has no managed Git worktree to remove.",
			};
		case "graphite":
			return {
				id,
				refNoun: "Graphite branch",
				workstreamNoun: "Graphite checkout",
				baseUpdateVerb: "restack",
				childGuidance: graphiteChildGuidance,
				remoteBaseDisplay: (baseRef) => `origin/${baseRef}`,
				baseUpdateDisclosure: "A restack can rewrite this branch; Kstack proved it currently has no local descendants.",
				fixPublicationDisclosure:
					"Graphite may rewrite the selected branch; Kstack rechecks that it has no descendants immediately before recording. It will not merge the PR or change merge settings.",
				conflictRuleSuffix: "; Graphite mutations proceed only when no local descendants exist",
				taskWorkstreamSummary: "creates a dedicated branch and incremental Git commits",
				approvalSummary: "creates a dedicated branch and incremental local commits",
				currentWorkspaceLabel: "current Git checkout",
				currentModeDisclosure: standardCurrentModeDisclosure,
				cleanupCompleteNotice: standardCleanupNotice,
			};
		default: {
			const _exhaustive: never = id;
			return _exhaustive;
		}
	}
}
