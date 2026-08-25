import type { ExecFn } from "../shared/git-exec.ts";
import { type PrTarget, resolvePrTarget } from "./pr-target.ts";
import { collectScope, type GitExec, resolveBase, type ScopeBundle } from "./review-scope.ts";
import type { BaseResolution, PanelArgs } from "./types.ts";

export type ResolvedReviewTarget =
	| { kind: "worktree"; base: BaseResolution }
	| { kind: "pr"; base: BaseResolution; pr: PrTarget };

export async function resolveReviewTarget(
	exec: ExecFn,
	gitExec: GitExec,
	repoRoot: string,
	options: PanelArgs,
): Promise<ResolvedReviewTarget> {
	if (options.pr === undefined) {
		return { kind: "worktree", base: resolveBase(gitExec, repoRoot, options.base) };
	}
	const pr = await resolvePrTarget(exec, repoRoot, options.pr);
	return {
		kind: "pr",
		pr,
		base: { ref: pr.baseRefName, mergeBaseSha: pr.mergeBaseSha, strategy: "pr" },
	};
}

function gitSafe(exec: GitExec, args: string[], cwd: string): string {
	try {
		return exec(args, cwd);
	} catch {
		return "";
	}
}

export function buildIntentPrefill(target: ResolvedReviewTarget, gitExec: GitExec, repoRoot: string): string {
	if (target.kind === "pr") {
		const subjects = gitSafe(
			gitExec,
			["log", "--format=%s", `${target.pr.mergeBaseSha}..${target.pr.headSha}`],
			repoRoot,
		);
		return `Review PR #${target.pr.number}: ${target.pr.title}\n${subjects.trim() ? `\nCommits in PR:\n${subjects.trim()}\n` : ""}\nIntent: `;
	}
	const subjects = gitSafe(gitExec, ["log", "--format=%s", `${target.base.mergeBaseSha}..HEAD`], repoRoot);
	return subjects.trim() ? `Review these changes:\n${subjects.trim()}\n\nIntent: ` : "";
}

export function collectTargetScope(target: ResolvedReviewTarget, repoRoot: string, intent: string): ScopeBundle {
	return target.kind === "pr"
		? collectScope(repoRoot, target.base, intent, { headSha: target.pr.headSha })
		: collectScope(repoRoot, target.base, intent);
}

export function noChangesMessage(target: ResolvedReviewTarget, scope: ScopeBundle): string {
	if (target.kind === "pr") {
		return `No reviewable changes for PR #${target.pr.number} (${target.pr.headSha.slice(0, 8)}) against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}).`;
	}
	return `No reviewable changes against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}). Commit, stage, or modify files first — or pass --base for a wider range.`;
}
