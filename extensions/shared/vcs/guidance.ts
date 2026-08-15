import type { VcsBackendId } from "./config.ts";

/** Backend-specific child-agent policy injected by the parent orchestrator. */
export function vcsChildGuidance(backend: VcsBackendId): string {
	if (backend === "jj") {
		return [
			"VCS backend: jj.",
			"Use jj for all version-control state and mutations. Do not run git status, add, commit, checkout, switch, merge, rebase, restore, or push.",
			"Inspect with jj status/diff/log. Record work with jj describe, jj commit, or jj new as appropriate, and keep the task bookmark on the change intended for publication.",
			"Do not create Git branches or worktrees. Leave an empty jj working-copy commit after recording the implementation.",
		].join(" ");
	}
	return [
		"VCS backend: git.",
		"Use Git for all version-control state and mutations. Do not run jj commands.",
		"Work only on the branch or worktree prepared by the parent, make incremental Git commits, and leave the working tree clean.",
	].join(" ");
}
