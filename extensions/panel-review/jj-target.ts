/** Pin the jj working-copy revision and its base for a snapshot review. */

import { pinnedGitArgs } from "./pinned-git.ts";
import { type CommandExec, defaultCommandExec, type RepositorySource, tryCommand } from "./repository-source.ts";
import type { BaseResolution, BaseStrategy } from "./types.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;
/** jj's virtual root commit, which has no Git counterpart. */
const ROOT_COMMIT = "0".repeat(40);

interface JjReviewTarget {
	headSha: string;
	base: BaseResolution;
	warnings: string[];
}

/** Base revision before its Git merge base is computed. */
interface BaseCandidate {
	ref: string;
	sha: string;
	strategy: BaseStrategy;
	warning?: string;
}

function resolveSingleRevision(exec: CommandExec, cwd: string, revision: string, label: string): string {
	const output = tryCommand(
		exec,
		"jj",
		["log", "--no-graph", "--limit", "2", "-r", revision, "-T", 'commit_id ++ "\\n"'],
		cwd,
	);
	const commits = output
		?.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!commits || commits.length === 0) throw new Error(`Could not resolve jj ${label} ${JSON.stringify(revision)}.`);
	if (commits.length !== 1 || !SHA_RE.test(commits[0])) {
		throw new Error(`jj ${label} ${JSON.stringify(revision)} must resolve to exactly one commit.`);
	}
	return commits[0].toLowerCase();
}

/**
 * Default base selection. `trunk()` is jj's remote-tracking default branch and
 * resolves to the virtual root commit when the repository has no remote; the
 * root has no Git commit, so fall back to local `main` / `master` bookmarks.
 */
function resolveDefaultBase(exec: CommandExec, cwd: string): BaseCandidate {
	const trunk = resolveSingleRevision(exec, cwd, "trunk()", "base revision");
	if (trunk !== ROOT_COMMIT) return { ref: "trunk()", sha: trunk, strategy: "jj-trunk" };
	for (const bookmark of ["main", "master"] as const) {
		const sha = tryCommand(
			exec,
			"jj",
			["log", "--no-graph", "--limit", "1", "-r", `present(${bookmark})`, "-T", "commit_id"],
			cwd,
		)?.trim();
		if (sha && SHA_RE.test(sha)) {
			return {
				ref: bookmark,
				sha: sha.toLowerCase(),
				strategy: bookmark,
				warning: `jj trunk() resolves to the root commit (no remote default branch); reviewing against local bookmark ${bookmark} instead.`,
			};
		}
	}
	throw new Error(
		"jj trunk() resolves to the root commit and no local main or master bookmark exists. Pass --base <revset>.",
	);
}

export function resolveJjReviewTarget(
	source: RepositorySource,
	explicitBase?: string,
	exec: CommandExec = defaultCommandExec,
): JjReviewTarget {
	const cwd = source.root;
	const conflicts = tryCommand(
		exec,
		"jj",
		["log", "--no-graph", "-r", "conflicts() & @", "-T", 'commit_id ++ "\\n"'],
		cwd,
	);
	if (conflicts === null) throw new Error("Could not inspect the jj working-copy commit for conflicts.");
	if (conflicts.trim())
		throw new Error("Cannot review a conflicted jj working-copy commit. Resolve its conflicts first.");

	const headSha = resolveSingleRevision(exec, cwd, "@", "working-copy revision");
	const warnings: string[] = [];
	let base: BaseCandidate;
	if (explicitBase === undefined) {
		base = resolveDefaultBase(exec, cwd);
		if (base.warning) warnings.push(base.warning);
	} else {
		base = {
			ref: explicitBase,
			sha: resolveSingleRevision(exec, cwd, explicitBase, "base revision"),
			strategy: "explicit",
		};
	}
	let mergeBaseSha = "";
	try {
		mergeBaseSha = source
			.git(pinnedGitArgs(["merge-base", base.sha, headSha]), cwd)
			.trim()
			.toLowerCase();
	} catch {
		/* reported below */
	}
	if (!SHA_RE.test(mergeBaseSha)) {
		throw new Error(`Could not calculate a merge base between jj revisions ${base.ref} and @.`);
	}
	return { headSha, base: { ref: base.ref, mergeBaseSha, strategy: base.strategy }, warnings };
}
