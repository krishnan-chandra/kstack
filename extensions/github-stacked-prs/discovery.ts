/** Derive one linear stack manifest from local Git branch ancestry. */

import { commandDiagnostic, type ExecFn, runCommand } from "../shared/git-exec.ts";
import type { GitHubGateway } from "../shared/github.ts";
import {
	MAX_STACK_SLICES,
	MAX_STACK_SUBJECT_CHARS,
	OWNED_STACK_REF_RE,
	STACK_SHA_RE,
	type StackManifest,
	type StackManifestSlice,
} from "../shared/stack/manifest.ts";
import { preflightVcs } from "../shared/vcs/preflight.ts";
import { requireGit238, resolveGitRemote, resolveGitTrunk } from "./repository.ts";

export async function discoverGitHubStack(input: {
	cwd: string;
	top: string;
	remote: string;
	exec: ExecFn;
	gateway: Pick<GitHubGateway, "getDefaultBranch">;
	signal?: AbortSignal;
}): Promise<{ ok: true; manifest: StackManifest; repositoryRoot: string } | { ok: false; error: string }> {
	if (!OWNED_STACK_REF_RE.test(input.top)) return { ok: false, error: `Top branch ${input.top} is not kstack-owned.` };
	const preflight = await preflightVcs(input.cwd, "git", input.exec);
	if (!preflight.ok) return preflight;
	const repositoryRoot = preflight.workspaceRoot;
	const version = await requireGit238(repositoryRoot, input.exec);
	if (!version.ok) return version;
	const remote = await resolveGitRemote(repositoryRoot, input.remote, input.exec, input.signal);
	if (!remote.ok) return remote;
	const trunk = await resolveGitTrunk({
		cwd: repositoryRoot,
		remote: remote.remote,
		exec: input.exec,
		gateway: input.gateway,
		signal: input.signal,
		fetch: true,
	});
	if (!trunk.ok) return trunk;
	const top = await runCommand(
		input.exec,
		"git",
		["rev-parse", "--verify", `refs/heads/${input.top}^{commit}`],
		repositoryRoot,
		input.signal,
	);
	const topSha = top.stdout.trim();
	if (top.code !== 0 || !STACK_SHA_RE.test(topSha))
		return { ok: false, error: `Local top branch ${input.top} is missing.` };
	const mergeBase = await runCommand(
		input.exec,
		"git",
		["merge-base", topSha, trunk.trunk.sha],
		repositoryRoot,
		input.signal,
	);
	const baseSha = mergeBase.stdout.trim();
	if (mergeBase.code !== 0 || !STACK_SHA_RE.test(baseSha))
		return { ok: false, error: "Could not find a merge-base with trunk." };
	if (baseSha !== trunk.trunk.sha) {
		return {
			ok: false,
			error: `The local stack is based on ${baseSha}, not latest trunk ${trunk.trunk.sha}. Rebase the stack onto latest trunk before publishing.`,
		};
	}
	const range = `${baseSha}..${topSha}`;
	const commitsResult = await runCommand(
		input.exec,
		"git",
		["rev-list", "--first-parent", "--reverse", range],
		repositoryRoot,
		input.signal,
	);
	if (commitsResult.code !== 0)
		return { ok: false, error: `Could not inspect stack ancestry: ${commandDiagnostic(commitsResult)}` };
	const commits = commitsResult.stdout.split(/\r?\n/).filter(Boolean);
	if (commits.length === 0) return { ok: false, error: "The selected top branch has no commits above trunk." };
	const merges = await runCommand(
		input.exec,
		"git",
		["rev-list", "--min-parents=2", range],
		repositoryRoot,
		input.signal,
	);
	if (merges.code !== 0) return { ok: false, error: `Could not inspect merge commits: ${commandDiagnostic(merges)}` };
	if (merges.stdout.trim()) return { ok: false, error: "The selected stack range contains a merge commit." };

	const refs = await runCommand(
		input.exec,
		"git",
		["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"],
		repositoryRoot,
		input.signal,
	);
	if (refs.code !== 0) return { ok: false, error: `Could not list local branches: ${commandDiagnostic(refs)}` };
	const position = new Map(commits.map((sha, index) => [sha, index]));
	const tips: Array<{ branch: string; sha: string; index: number }> = [];
	for (const line of refs.stdout.split(/\r?\n/)) {
		if (!line) continue;
		const tab = line.indexOf("\t");
		if (tab <= 0) return { ok: false, error: "Git returned an invalid local-branch record." };
		const branch = line.slice(0, tab);
		const sha = line.slice(tab + 1);
		const index = position.get(sha);
		if (index === undefined) continue;
		if (!OWNED_STACK_REF_RE.test(branch)) {
			return { ok: false, error: `Non-kstack branch ${branch} points inside the selected stack range.` };
		}
		tips.push({ branch, sha, index });
	}
	tips.sort((left, right) => left.index - right.index || left.branch.localeCompare(right.branch));
	if (tips.length === 0 || !tips.some((tip) => tip.branch === input.top && tip.sha === topSha)) {
		return { ok: false, error: "No complete kstack branch chain reaches the selected top." };
	}
	if (tips.length > MAX_STACK_SLICES) return { ok: false, error: `The stack exceeds ${MAX_STACK_SLICES} slices.` };
	for (let index = 1; index < tips.length; index++) {
		if (tips[index].index === tips[index - 1].index) {
			return { ok: false, error: `Multiple kstack branches point to ${tips[index].sha}; the stack is ambiguous.` };
		}
	}
	const slices: StackManifestSlice[] = [];
	for (const [index, tip] of tips.entries()) {
		const subject = await runCommand(
			input.exec,
			"git",
			["show", "-s", "--format=%s", tip.sha],
			repositoryRoot,
			input.signal,
		);
		const value = subject.stdout.trim();
		if (subject.code !== 0 || !value || value.length > MAX_STACK_SUBJECT_CHARS || /[\0\r\n]/.test(value)) {
			return { ok: false, error: `Could not read a bounded subject for ${tip.branch}.` };
		}
		slices.push({
			branch: tip.branch,
			baseBranch: index === 0 ? trunk.trunk.ref : tips[index - 1].branch,
			headSha: tip.sha,
			subject: value,
		});
	}
	return {
		ok: true,
		repositoryRoot,
		manifest: { schemaVersion: 1, trunkRef: trunk.trunk.ref, trunkSha: trunk.trunk.sha, slices },
	};
}
