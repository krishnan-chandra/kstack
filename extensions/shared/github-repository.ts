import { commandDiagnostic, type ExecFn, runCommand } from "./git-exec.ts";
import { parseGithubUrl, resolveRepoNameResult } from "./github.ts";
import { type BoundaryValue, isString } from "./validation.ts";
import type { VcsBackendId } from "./vcs/config.ts";

const MAX_REMOTE_LIST_BYTES = 64 * 1024;
const MAX_REMOTE_COUNT = 100;
const MAX_DIAGNOSTIC_CHARS = 1024;

/** Repository coordinates accepted by trusted in-process GitHub requests. */
export function isRepositoryName(value: BoundaryValue): value is string {
	return isString(value) && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function boundedDiagnostic(text: string): string {
	return text.trim().slice(0, MAX_DIAGNOSTIC_CHARS) || "unknown command failure";
}

type GitHubRepositoryResolution =
	| { ok: true; repository: string }
	| { ok: false; kind: "cancelled" }
	| { ok: false; kind: "failed"; error: string };

/** Resolve the GitHub repository selected by a configured VCS backend. */
export async function resolveGitHubRepository(
	exec: ExecFn,
	cwd: string,
	backend: VcsBackendId,
	signal?: AbortSignal,
): Promise<GitHubRepositoryResolution> {
	if (signal?.aborted) return { ok: false, kind: "cancelled" };
	if (backend !== "jj") {
		const result = await resolveRepoNameResult(exec, cwd, signal);
		if (signal?.aborted) return { ok: false, kind: "cancelled" };
		if (result.repo && isRepositoryName(result.repo)) return { ok: true, repository: result.repo };
		return {
			ok: false,
			kind: "failed",
			error: `Could not resolve the GitHub repository from the ${backend} worktree: ${boundedDiagnostic(commandDiagnostic(result))}`,
		};
	}

	const result = await runCommand(exec, "jj", ["git", "remote", "list", "--no-pager", "--color=never"], cwd, signal);
	if (signal?.aborted) return { ok: false, kind: "cancelled" };
	if (result.code !== 0) {
		return {
			ok: false,
			kind: "failed",
			error: `Could not inspect jj remotes: ${boundedDiagnostic(commandDiagnostic(result))}`,
		};
	}
	if (Buffer.byteLength(result.stdout) > MAX_REMOTE_LIST_BYTES) {
		return { ok: false, kind: "failed", error: "Could not inspect jj remotes: remote output exceeded 64 KiB." };
	}
	const lines = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length > MAX_REMOTE_COUNT) {
		return {
			ok: false,
			kind: "failed",
			error: `Could not inspect jj remotes: more than ${MAX_REMOTE_COUNT} remotes were returned.`,
		};
	}
	const remoteNames = new Set<string>();
	let origin: string | undefined;
	for (const line of lines) {
		const match = /^(\S+)[ \t]+(\S.*)$/.exec(line);
		if (!match) {
			return { ok: false, kind: "failed", error: "Could not inspect jj remotes: malformed remote output." };
		}
		if (remoteNames.has(match[1])) {
			return {
				ok: false,
				kind: "failed",
				error: `Could not inspect jj remotes: duplicate remote ${JSON.stringify(match[1])}.`,
			};
		}
		remoteNames.add(match[1]);
		if (match[1] === "origin") origin = match[2];
	}
	if (origin === undefined) {
		return {
			ok: false,
			kind: "failed",
			error: "The jj workspace requires a GitHub remote named origin for standalone PR workflows.",
		};
	}
	const repository = parseGithubUrl(origin);
	const name = repository ? `${repository.owner}/${repository.repo}` : undefined;
	return name && isRepositoryName(name)
		? { ok: true, repository: name }
		: { ok: false, kind: "failed", error: "The jj origin remote is not a valid GitHub repository." };
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
