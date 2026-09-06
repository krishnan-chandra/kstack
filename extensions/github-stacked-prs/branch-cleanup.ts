import { commandDiagnostic, type ExecFn, runCommand } from "../shared/git-exec.ts";
import { STACK_SHA_RE } from "../shared/stack/manifest.ts";

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

interface WorktreeRecord {
	path: string;
	head?: string;
	branch?: string;
}

type WorktreeParseResult = { ok: true; value: readonly WorktreeRecord[] } | { ok: false; error: string };

function parseWorktrees(stdout: string): WorktreeParseResult {
	if (!stdout?.endsWith("\0\0")) {
		return { ok: false, error: "Git returned an empty or unterminated worktree inventory." };
	}
	const chunks = stdout.slice(0, -2).split("\0\0");
	const records: WorktreeRecord[] = [];
	const paths = new Set<string>();
	for (const chunk of chunks) {
		const fields = chunk.split("\0");
		const first = fields.shift();
		if (!first?.startsWith("worktree ") || first.length === "worktree ".length) {
			return { ok: false, error: "Git returned an invalid worktree record." };
		}
		const path = first.slice("worktree ".length);
		if (paths.has(path)) return { ok: false, error: "Git returned duplicate worktree records." };
		paths.add(path);
		let head: string | undefined;
		let branch: string | undefined;
		let bare = false;
		let detached = false;
		for (const field of fields) {
			if (field.startsWith("HEAD ") && head === undefined) {
				head = field.slice("HEAD ".length);
			} else if (field.startsWith("branch ") && branch === undefined) {
				const ref = field.slice("branch ".length);
				if (!ref.startsWith(LOCAL_REF_PREFIX) || ref.length === LOCAL_REF_PREFIX.length) {
					return { ok: false, error: "Git returned an invalid worktree branch record." };
				}
				branch = ref.slice(LOCAL_REF_PREFIX.length);
			} else if (field === "bare" && !bare) {
				bare = true;
			} else if (field === "detached" && !detached) {
				detached = true;
			} else {
				const optionalAttribute =
					field === "locked" || field.startsWith("locked ") || field === "prunable" || field.startsWith("prunable ");
				if (!optionalAttribute) return { ok: false, error: "Git returned an invalid worktree record." };
			}
		}
		const stateCount = Number(branch !== undefined) + Number(bare) + Number(detached);
		if (stateCount !== 1 || (bare ? head !== undefined : !head || !STACK_SHA_RE.test(head))) {
			return { ok: false, error: "Git returned an incomplete worktree record." };
		}
		records.push({ path, head, branch });
	}
	if (records.length === 0) return { ok: false, error: "Git returned an empty worktree inventory." };
	return { ok: true, value: records };
}

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

	const checkedOutWorktree = worktrees.value.find((wt) => wt.branch === branch);
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
