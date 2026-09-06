import type { ExecFn } from "./git-exec.ts";
import { type BoundaryValue, isString } from "./validation.ts";

/** Repository coordinates accepted by trusted in-process GitHub requests. */
export function isRepositoryName(value: BoundaryValue): value is string {
	return isString(value) && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

/** Scope delegated PR, run, and repository queries without changing process-wide environment. */
export function scopeGitHubExec(exec: ExecFn, repository: string): ExecFn {
	if (!isRepositoryName(repository)) throw new Error("Invalid GitHub repository: expected owner/name.");
	return (command, args, options) => {
		if (command !== "gh") return exec(command, args, options);
		if (args[0] === "pr" || args[0] === "run") {
			return exec(command, [...args, "--repo", repository], options);
		}
		if (args[0] === "repo" && args[1] === "view") {
			return exec(command, ["repo", "view", repository, ...args.slice(2)], options);
		}
		// API callers already supply explicit paths, GraphQL coordinates, or global node IDs.
		return exec(command, args, options);
	};
}
