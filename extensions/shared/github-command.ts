import type { ExecFn, ExecFnResult } from "./git-exec.ts";
import type { BoundaryValue } from "./validation.ts";

const GATEWAY_MUTATION_MS = 30_000;

/** A conclusive GitHub failure or an execution whose remote outcome is unknown. */
export class GitHubError extends Error {
	readonly kind: "failed" | "indeterminate";
	constructor(message: string, kind: "failed" | "indeterminate" = "failed") {
		super(message);
		this.kind = kind;
	}
}

export function isGitHubIndeterminate(error: BoundaryValue): boolean {
	return error instanceof GitHubError && error.kind === "indeterminate";
}

/** Execute a GitHub mutation while preserving uncertain process termination. */
export async function runGitHubMutation(
	exec: ExecFn,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): Promise<{ stdout: string }> {
	if (options.signal?.aborted) {
		throw new GitHubError(`gh ${args[0]} was aborted before execution.`);
	}
	let result: ExecFnResult;
	try {
		result = await exec("gh", args, {
			cwd: options.cwd,
			timeout: GATEWAY_MUTATION_MS,
			signal: options.signal,
		});
	} catch (error) {
		if (error instanceof GitHubError) throw error;
		throw new GitHubError(
			`gh ${args[0]} ended without a conclusive result: ${error instanceof Error ? error.message : String(error)}`,
			"indeterminate",
		);
	}
	if (result.killed) {
		throw new GitHubError(
			`gh ${args[0]} was killed before a conclusive result: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
			"indeterminate",
		);
	}
	if (result.code !== 0) {
		throw new GitHubError(
			`gh ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
		);
	}
	return { stdout: result.stdout };
}
