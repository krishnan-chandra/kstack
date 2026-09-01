import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { GitExec } from "./review-scope.ts";
import type { BaseResolution } from "./types.ts";

const SHA_RE = /^[0-9a-f]{40}$/i;

type CommandExec = (command: string, args: string[], cwd: string) => string;

const defaultCommandExec: CommandExec = (command, args, cwd) =>
	execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

export interface JjReviewTarget {
	workspaceRoot: string;
	gitRoot: string;
	headSha: string;
	base: BaseResolution;
}

function tryCommand(exec: CommandExec, command: string, args: string[], cwd: string): string | null {
	try {
		return exec(command, args, cwd);
	} catch {
		return null;
	}
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

export function resolveJjReviewTarget(
	cwd: string,
	explicitBase?: string,
	exec: CommandExec = defaultCommandExec,
): JjReviewTarget | null {
	const workspace = tryCommand(exec, "jj", ["workspace", "root"], cwd)?.trim();
	if (!workspace) return null;
	const gitRoot = tryCommand(exec, "jj", ["git", "root"], workspace)?.trim();
	if (!gitRoot) throw new Error(`${workspace} is a jj workspace without a colocated Git store.`);

	const workspaceRoot = realpathSync(workspace);
	const resolvedGitRoot = realpathSync(gitRoot);
	const conflicts = tryCommand(
		exec,
		"jj",
		["log", "--no-graph", "-r", "conflicts() & @", "-T", 'commit_id ++ "\\n"'],
		workspaceRoot,
	);
	if (conflicts === null) throw new Error("Could not inspect the jj working-copy commit for conflicts.");
	if (conflicts.trim())
		throw new Error("Cannot review a conflicted jj working-copy commit. Resolve its conflicts first.");

	const headSha = resolveSingleRevision(exec, workspaceRoot, "@", "working-copy revision");
	const baseRef = explicitBase ?? "trunk()";
	const baseCommit = resolveSingleRevision(exec, workspaceRoot, baseRef, "base revision");
	const mergeBase = tryCommand(
		exec,
		"git",
		[`--git-dir=${resolvedGitRoot}`, "merge-base", baseCommit, headSha],
		workspaceRoot,
	)
		?.trim()
		.toLowerCase();
	if (!mergeBase || !SHA_RE.test(mergeBase)) {
		throw new Error(`Could not calculate a merge base between jj revisions ${baseRef} and @.`);
	}
	return {
		workspaceRoot,
		gitRoot: resolvedGitRoot,
		headSha,
		base: { ref: baseRef, mergeBaseSha: mergeBase, strategy: explicitBase ? "explicit" : "jj-trunk" },
	};
}

export function createGitStoreExec(gitRoot: string): GitExec {
	return (args, cwd) =>
		execFileSync("git", [`--git-dir=${gitRoot}`, ...args], {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			shell: false,
		});
}
