import type { ExecFn, ExecFnResult } from "./git-exec.ts";
import { slugifyWorktreeTask } from "./worktree.ts";

const MAX_COLLISION_ATTEMPTS = 100;

export interface WorkstreamCheckpoint {
	branch: string;
	baseSha: string;
}

type BranchResult = ({ ok: true } & WorkstreamCheckpoint) | { ok: false; error: string };
type VerifyResult = { ok: true; headSha: string } | { ok: false; error: string };

async function git(exec: ExecFn, cwd: string, args: string[]): Promise<ExecFnResult> {
	try {
		return await exec("git", args, { cwd, timeout: 10_000 });
	} catch (error) {
		return { code: 1, stdout: "", stderr: (error as Error).message };
	}
}

function output(result: ExecFnResult): string {
	return result.stdout.trim();
}

export async function createCurrentWorkstreamBranch(cwd: string, task: string, exec: ExecFn): Promise<BranchResult> {
	const status = await git(exec, cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.code !== 0)
		return { ok: false, error: `Could not inspect the working tree: ${status.stderr.trim() || status.stdout.trim()}` };
	if (output(status))
		return {
			ok: false,
			error: `The current working tree is dirty; no task branch was created. Rerun with --worktree.\n${output(status)}`,
		};

	const base = await git(exec, cwd, ["rev-parse", "HEAD"]);
	const baseSha = output(base);
	if (base.code !== 0 || !/^[0-9a-f]{40}$/.test(baseSha)) {
		return { ok: false, error: `Could not resolve the current HEAD: ${base.stderr.trim() || base.stdout.trim()}` };
	}

	const slug = slugifyWorktreeTask(task);
	for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
		const branch = `kstack/${slug}${attempt === 1 ? "" : `-${attempt}`}`;
		const exists = await git(exec, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		if (exists.code === 0) continue;
		const created = await git(exec, cwd, ["switch", "-c", branch]);
		if (created.code !== 0)
			return {
				ok: false,
				error: `Could not create task branch ${branch}: ${created.stderr.trim() || created.stdout.trim()}`,
			};
		return { ok: true, branch, baseSha };
	}
	return { ok: false, error: `Could not allocate a unique task branch after ${MAX_COLLISION_ATTEMPTS} attempts.` };
}

export async function verifyCommittedWorkstream(
	cwd: string,
	exec: ExecFn,
	expected: WorkstreamCheckpoint & { requireNewCommit: boolean },
): Promise<VerifyResult> {
	const branchResult = await git(exec, cwd, ["branch", "--show-current"]);
	const branch = output(branchResult);
	if (branchResult.code !== 0 || branch !== expected.branch) {
		return {
			ok: false,
			error: `Workstream postcondition failed: expected branch ${expected.branch}, found ${branch || "detached HEAD"}.`,
		};
	}
	const headResult = await git(exec, cwd, ["rev-parse", "HEAD"]);
	const headSha = output(headResult);
	if (headResult.code !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) {
		return {
			ok: false,
			error: `Workstream postcondition failed: could not resolve HEAD: ${headResult.stderr.trim() || headResult.stdout.trim()}`,
		};
	}
	if (expected.requireNewCommit && headSha === expected.baseSha) {
		return { ok: false, error: "Workstream postcondition failed: implementation created no commits." };
	}
	const status = await git(exec, cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.code !== 0)
		return { ok: false, error: `Could not verify the working tree: ${status.stderr.trim() || status.stdout.trim()}` };
	if (output(status))
		return { ok: false, error: `Workstream postcondition failed: uncommitted files remain.\n${output(status)}` };
	return { ok: true, headSha };
}
