import type { VcsBackendId } from "../shared/vcs/config.ts";
import type { DeliveryMode, WorkLocation } from "./types.ts";

/** Validate delivery/isolation choices against the configured VCS backend. */
export function validateVcsMode(
	backend: VcsBackendId,
	mode: DeliveryMode,
	workLocation: WorkLocation,
): string | undefined {
	if (mode === "stack" && workLocation === "worktree") return "--stack and --worktree cannot currently be combined.";
	if (mode === "stack" && backend === "git") {
		return "Stack delivery requires the jj or Graphite backend. Run /skill:setup-kstack to select one, or use single delivery.";
	}
	if (workLocation === "worktree" && backend === "jj") {
		return "--worktree requires the Git or Graphite backend. The jj backend runs single delivery in the current workspace.";
	}
	return undefined;
}
