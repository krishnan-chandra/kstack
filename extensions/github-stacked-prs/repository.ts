/** Git and remote identity helpers for the GitHub stack provider. */

import { commandDiagnostic, type ExecFn, runCommand } from "../shared/git-exec.ts";
import { type GitHubGateway, type GitHubRepository, parseGithubUrl } from "../shared/github.ts";
import { STACK_SHA_RE } from "../shared/stack/manifest.ts";
import { compareSemver, parseSemver } from "../shared/vcs/preflight.ts";

const MIN_GIT: readonly [number, number, number] = [2, 38, 0];

interface GitRemote {
	name: string;
	repository: GitHubRepository;
}

interface GitTrunk {
	branch: string;
	ref: string;
	sha: string;
}

export async function requireGit238(cwd: string, exec: ExecFn): Promise<{ ok: true } | { ok: false; error: string }> {
	const result = await runCommand(exec, "git", ["--version"], cwd);
	const version = parseSemver(result.stdout);
	if (result.code !== 0 || !version || compareSemver(version, MIN_GIT) < 0) {
		return { ok: false, error: `The GitHub stack provider requires Git >= ${MIN_GIT.join(".")}.` };
	}
	return { ok: true };
}

export async function resolveGitRemote(
	cwd: string,
	remote: string,
	exec: ExecFn,
	signal?: AbortSignal,
): Promise<{ ok: true; remote: GitRemote } | { ok: false; error: string }> {
	const result = await runCommand(exec, "git", ["remote", "get-url", remote], cwd, signal);
	if (result.code !== 0) {
		return { ok: false, error: `Could not resolve remote ${remote}: ${commandDiagnostic(result)}` };
	}
	const repository = parseGithubUrl(result.stdout.trim());
	if (!repository) return { ok: false, error: `Remote ${remote} is not a GitHub repository.` };
	return { ok: true, remote: { name: remote, repository } };
}

export async function resolveGitTrunk(input: {
	cwd: string;
	remote: GitRemote;
	exec: ExecFn;
	gateway: Pick<GitHubGateway, "getDefaultBranch">;
	signal?: AbortSignal;
	fetch: boolean;
}): Promise<{ ok: true; trunk: GitTrunk } | { ok: false; error: string }> {
	const symbolic = await runCommand(
		input.exec,
		"git",
		["symbolic-ref", `refs/remotes/${input.remote.name}/HEAD`],
		input.cwd,
		input.signal,
		8_000,
	);
	const prefix = `refs/remotes/${input.remote.name}/`;
	let branch =
		symbolic.code === 0 && symbolic.stdout.trim().startsWith(prefix)
			? symbolic.stdout.trim().slice(prefix.length)
			: undefined;
	if (!branch) {
		try {
			branch = await input.gateway.getDefaultBranch(input.remote.repository, input.cwd, input.signal);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	if (input.fetch) {
		const fetched = await runCommand(
			input.exec,
			"git",
			["fetch", input.remote.name, `+refs/heads/${branch}:refs/remotes/${input.remote.name}/${branch}`],
			input.cwd,
			input.signal,
			60_000,
		);
		if (fetched.code !== 0)
			return { ok: false, error: `Could not fetch ${input.remote.name}/${branch}: ${commandDiagnostic(fetched)}` };
	}
	const remoteRef = `refs/remotes/${input.remote.name}/${branch}`;
	let resolvedRef = remoteRef;
	let resolved = await runCommand(
		input.exec,
		"git",
		["rev-parse", "--verify", `${remoteRef}^{commit}`],
		input.cwd,
		input.signal,
	);
	if (resolved.code !== 0 && !input.fetch) {
		resolvedRef = `refs/heads/${branch}`;
		resolved = await runCommand(
			input.exec,
			"git",
			["rev-parse", "--verify", `${resolvedRef}^{commit}`],
			input.cwd,
			input.signal,
		);
	}
	const sha = resolved.stdout.trim();
	if (resolved.code !== 0 || !STACK_SHA_RE.test(sha)) {
		return { ok: false, error: `Could not resolve local trunk ref for ${input.remote.name}/${branch}.` };
	}
	return { ok: true, trunk: { branch, ref: resolvedRef, sha } };
}

export function trunkBranchFromManifestRef(ref: string): string {
	const remoteMatch = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref);
	if (remoteMatch) return remoteMatch[1];
	return ref.replace(/^refs\/heads\//, "");
}
