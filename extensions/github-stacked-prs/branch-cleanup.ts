import { commandDiagnostic, type ExecFn, runCommand } from "../shared/git-exec.ts";
import { parseWorktrees, type WorktreeRecord } from "./rebase-scope.ts";

/**
 * Local branch cleanup for landed stack entries.
 *
 * Deletes the local branch only when its tip matches the expected landed head SHA,
 * using atomic compare-and-delete (git update-ref --no-deref -d).
 *
 * Concurrency limit: External worktree checkouts are inspected immediately before
 * deletion, but are not atomically coordinated with ref deletion.
 * Branch configuration (branch.<name>.*) in .git/config is deliberately retained
 * so that any concurrently recreated branch does not lose configuration.
 */

const LOCAL_REF_PREFIX = "refs/heads/";

export interface CleanupLocalBranchInput {
	branch: string;
	expectedHeadSha: string;
	cwd: string;
	exec: ExecFn;
	signal?: AbortSignal;
}

export interface CleanupLocalBranchResult {
	completedMutations: string[];
	warnings: string[];
}

export async function cleanupLocalBranch(input: CleanupLocalBranchInput): Promise<CleanupLocalBranchResult> {
	const completedMutations: string[] = [];
	const warnings: string[] = [];
	const branch = input.branch.startsWith(LOCAL_REF_PREFIX) ? input.branch.slice(LOCAL_REF_PREFIX.length) : input.branch;

	const worktreesResult = await runCommand(
		input.exec,
		"git",
		["worktree", "list", "--porcelain", "-z"],
		input.cwd,
		input.signal,
	);
	if (worktreesResult.code !== 0) {
		warnings.push(
			`Could not inspect Git worktrees before deleting local branch ${branch}: ${commandDiagnostic(worktreesResult)}. Retaining branch.`,
		);
		return { completedMutations, warnings };
	}
	const worktrees = parseWorktrees(worktreesResult.stdout);
	if (!worktrees.ok) {
		warnings.push(
			`Could not parse Git worktrees before deleting local branch ${branch}: ${worktrees.error}. Retaining branch.`,
		);
		return { completedMutations, warnings };
	}

	const checkedOutWorktree: WorktreeRecord | undefined = worktrees.value.find((wt) => wt.branch === branch);
	if (checkedOutWorktree) {
		warnings.push(
			`Skipped deleting local branch ${branch}: checked out in worktree ${JSON.stringify(checkedOutWorktree.path)}.`,
		);
		return { completedMutations, warnings };
	}

	const refName = `${LOCAL_REF_PREFIX}${branch}`;
	const preRead = await runCommand(
		input.exec,
		"git",
		["rev-parse", "--verify", "--quiet", refName],
		input.cwd,
		input.signal,
	);
	if (preRead.code !== 0) {
		// Nonzero exit with empty output means the branch is already gone: idempotent success, skip mutation
		if (!preRead.stdout.trim()) {
			return { completedMutations, warnings };
		}
		warnings.push(`Could not verify local branch ${branch}: ${commandDiagnostic(preRead)}. Retaining branch.`);
		return { completedMutations, warnings };
	}

	const currentSha = preRead.stdout.trim();
	if (currentSha !== input.expectedHeadSha) {
		warnings.push(`Skipped deleting local branch ${branch}: local head changed to ${currentSha}.`);
		return { completedMutations, warnings };
	}

	const symbolic = await runCommand(input.exec, "git", ["symbolic-ref", "-q", refName], input.cwd, input.signal);
	if (symbolic.code === 0) {
		warnings.push(`Skipped deleting local branch ${branch}: ref is a symbolic ref.`);
		return { completedMutations, warnings };
	}

	const deleteResult = await runCommand(
		input.exec,
		"git",
		["update-ref", "--no-deref", "-d", refName, input.expectedHeadSha],
		input.cwd,
		input.signal,
	);
	if (deleteResult.code === 0) {
		completedMutations.push(`Deleted local branch ${branch}`);
	} else {
		warnings.push(`Failed to delete local branch ${branch}: ref head changed or could not be locked.`);
	}

	return { completedMutations, warnings };
}
