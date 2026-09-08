/**
 * Choose what a panel review pins, given an already located repository.
 *
 * Targets are independent of repository layout: a PR resolves the same way
 * from a Git worktree or a jj workspace, and the jj working-copy revision is
 * pinned whenever jj owns the working copy.
 */

import { resolveJjReviewTarget } from "./jj-target.ts";
import { pinnedGitExec } from "./pinned-git.ts";
import { type PrTarget, resolvePrTarget } from "./pr-target.ts";
import type { CommandExec, RepositorySource } from "./repository-source.ts";
import { collectScope, type GitExec, resolveBase, type ScopeBundle } from "./review-scope.ts";
import type { BaseResolution, PanelArgs } from "./types.ts";

export type ResolvedReviewTarget =
	| { kind: "worktree"; base: BaseResolution }
	| { kind: "jj"; base: BaseResolution; headSha: string }
	| { kind: "pr"; base: BaseResolution; pr: PrTarget };

interface ReviewTargetResolution {
	target: ResolvedReviewTarget;
	warnings: string[];
}

interface ResolveTargetDeps {
	/** Synchronous jj runner; defaults to a real process. */
	commandExec?: CommandExec;
	signal?: AbortSignal;
}

export async function resolveReviewTarget(
	source: RepositorySource,
	options: PanelArgs,
	deps: ResolveTargetDeps = {},
): Promise<ReviewTargetResolution> {
	if (options.pr !== undefined) {
		const pr = await resolvePrTarget(source.exec, source.root, options.pr, deps.signal, source.githubRepository);
		return {
			target: { kind: "pr", pr, base: { ref: pr.baseRefName, mergeBaseSha: pr.mergeBaseSha, strategy: "pr" } },
			warnings: [],
		};
	}
	if (source.layout === "git-worktree") {
		return { target: { kind: "worktree", base: resolveBase(source.git, source.root, options.base) }, warnings: [] };
	}
	const jj = resolveJjReviewTarget(source, options.base, deps.commandExec);
	return { target: { kind: "jj", base: jj.base, headSha: jj.headSha }, warnings: jj.warnings };
}

/** Commit pinned by the target, or undefined when reviewing the live working tree. */
export function pinnedHeadSha(target: ResolvedReviewTarget): string | undefined {
	if (target.kind === "pr") return target.pr.headSha;
	if (target.kind === "jj") return target.headSha;
	return undefined;
}

function gitSafe(exec: GitExec, args: string[], cwd: string): string {
	try {
		return exec(args, cwd);
	} catch {
		return "";
	}
}

export function buildIntentPrefill(target: ResolvedReviewTarget, gitExec: GitExec, repoRoot: string): string {
	const pinnedHead = pinnedHeadSha(target);
	const objectExec = pinnedHead === undefined ? gitExec : pinnedGitExec(gitExec);
	if (target.kind === "pr") {
		const subjects = gitSafe(
			objectExec,
			["log", "--format=%s", `${target.pr.mergeBaseSha}..${target.pr.headSha}`],
			repoRoot,
		);
		return `Review PR #${target.pr.number}: ${target.pr.title}\n${subjects.trim() ? `\nCommits in PR:\n${subjects.trim()}\n` : ""}\nIntent: `;
	}
	const logArgs = ["log", "--format=%s", `${target.base.mergeBaseSha}..${pinnedHead ?? "HEAD"}`];
	const subjects = gitSafe(objectExec, logArgs, repoRoot);
	return subjects.trim() ? `Review these changes:\n${subjects.trim()}\n\nIntent: ` : "";
}

export function collectTargetScope(
	target: ResolvedReviewTarget,
	source: RepositorySource,
	intent: string,
): ScopeBundle {
	return collectScope(source.root, target.base, intent, {
		exec: source.git,
		repositoryRoot: source.root,
		headSha: pinnedHeadSha(target),
	});
}

export function noChangesMessage(target: ResolvedReviewTarget, scope: ScopeBundle): string {
	if (target.kind === "pr") {
		return `No reviewable changes for PR #${target.pr.number} (${target.pr.headSha.slice(0, 8)}) against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}).`;
	}
	if (target.kind === "jj") {
		return `No reviewable changes in jj revision @ (${target.headSha.slice(0, 8)}) against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}).`;
	}
	return `No reviewable changes against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}). Commit, stage, or modify files first — or pass --base for a wider range.`;
}
