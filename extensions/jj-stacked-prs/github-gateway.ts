import type { ExecFn } from "../shared/git-exec.ts";
import { createGitHubGateway, GitHubError, type GitHubGateway } from "../shared/github.ts";
import type { ProcessRunner } from "./process.ts";

/** Adapt the jj extension's rich process result to the shared GitHub gateway. */
export function createJjGitHubGateway(run: ProcessRunner): GitHubGateway {
	return createGitHubGateway(execFromRunner(run));
}

/** Preserve retry-safety classification while adapting a jj process runner. */
export function execFromRunner(run: ProcessRunner): ExecFn {
	return async (command, args, options) => {
		const result = await run([command, ...args], {
			cwd: options.cwd,
			timeoutMs: options.timeout,
			signal: options.signal,
		});
		if (result.kind === "ok" || result.kind === "nonzero") {
			return { code: result.code, stdout: result.stdout, stderr: result.stderr };
		}
		const kind =
			result.kind === "timeout" || result.kind === "cancelled" || result.kind === "uncertain"
				? "indeterminate"
				: "failed";
		throw new GitHubError(result.message, kind);
	};
}
