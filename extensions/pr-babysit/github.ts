/**
 * GitHub API interactions via the authenticated `gh` CLI.
 *
 * Every public function is a thin, typed wrapper around `gh` — no raw HTTP,
 * no embedded tokens. Credentials are owned by `gh`; they are never extracted,
 * logged, or embedded in arguments. All calls are bounded by timeout and
 * output caps.
 */

import type { CheckRun, ExecFn, ExecFnResult, ReviewThread } from "./types.ts";

/** Run a gh command and return its result. */
export async function gh(exec: ExecFn, cwd: string, args: string[]): Promise<ExecFnResult> {
	try {
		return await exec("gh", args, { cwd, timeout: 15_000 });
	} catch (error) {
		return { code: 1, stdout: "", stderr: (error as Error).message };
	}
}

/** Resolve the repo owner/name for the current checkout. */
export async function resolveRepo(exec: ExecFn, cwd: string): Promise<ExecFnResult & { repo?: string }> {
	const result = await gh(exec, cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
	if (result.code !== 0 || !result.stdout.trim()) {
		return { ...result, repo: undefined };
	}
	return { ...result, repo: result.stdout.trim() };
}

/**
 * Fetch the lowest unmerged open PR in the current repository, sorted by
 * number ascending. Returns nothing when no open PR exists.
 */
export async function findLowestUnmergedPR(exec: ExecFn, cwd: string): Promise<ExecFnResult & { prNumber?: number }> {
	const result = await gh(exec, cwd, [
		"pr", "list",
		"--state", "open",
		"--limit", "50",
		"--json", "number",
		"-q", ".[0].number",
	]);
	if (result.code !== 0) {
		return { ...result, prNumber: undefined };
	}
	const numStr = result.stdout.trim();
	const num = parseInt(numStr, 10);
	if (Number.isNaN(num) || num < 1) {
		return { ...result, prNumber: undefined };
	}
	return { ...result, prNumber: num };
}

export interface GHPrJson {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	mergeable: string;
	headRefName: string;
	baseRefName: string;
	headSha: string;
	commits?: Array<{ oid: string }>;
}

/**
 * Fetch a comprehensive PR state snapshot. Returns parsed JSON with the
 * fields needed by the babysitter: number, title, draft, mergeability,
 * head SHA, base ref, and commit SHAs.
 */
export async function viewPR(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
): Promise<ExecFnResult & { pr?: GHPrJson }> {
	const fields = "number,title,state,isDraft,mergeable,headRefName,baseRefName,headRefOid,commits";
	const result = await gh(exec, cwd, [
		"pr", "view",
		String(prNumber),
		"--json", fields,
		"-q", ".",
	]);
	if (result.code !== 0 || !result.stdout.trim()) {
		return { ...result, pr: undefined };
	}
	try {
		const parsed = JSON.parse(result.stdout.trim()) as Partial<GHPrJson> & { headRefOid?: string };
		const pr: GHPrJson = {
			number: parsed.number ?? 0,
			title: parsed.title ?? "",
			state: parsed.state ?? "open",
			isDraft: parsed.isDraft ?? false,
			mergeable: parsed.mergeable ?? "unknown",
			headRefName: parsed.headRefName ?? "",
			baseRefName: parsed.baseRefName ?? "",
			headSha: parsed.headRefOid ?? "",
			commits: parsed.commits ?? [],
		};
		if (pr.number === 0) return { ...result, pr: undefined };
		return { ...result, pr };
	} catch (error) {
		return { code: 1, stdout: "", stderr: `Could not parse gh pr view output: ${(error as Error).message}`, pr: undefined };
	}
}

export async function getReviewThreads(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
): Promise<ExecFnResult & { threads: ReviewThread[] }> {
	const fields = "id,author.login,body,state,path,line";
	const result = await gh(exec, cwd, [
		"api",
		`repos/{owner}/{repo}/pulls/${prNumber}/comments`,
		"--method", "GET",
		"--jq", `[.[] | {id: .id, commenter: .user.login, body: .body, status: .state, path: .path, line: .line}]`,
	]);
	if (result.code !== 0) {
		return { ...result, threads: [] };
	}
	try {
		const threads = JSON.parse(result.stdout.trim() || "[]") as RawThread[];
		return {
			...result,
			threads: threads.map((t) => ({
				id: String(t.id),
				commenter: t.commenter ?? "unknown",
				body: t.body ?? "",
				status: (t.status as ReviewThread["status"]) ?? "COMMENTED",
				path: t.path,
				line: t.line,
			})),
		};
	} catch (error) {
		return { code: 1, stdout: "", stderr: `Could not parse review threads: ${(error as Error).message}`, threads: [] };
	}
}

interface RawThread {
	id: number;
	commenter?: string;
	body?: string;
	status?: string;
	path?: string;
	line?: number;
}

/**
 * Fetch check runs (CI status) for a PR's head commit. Returns a list of
 * name + conclusion pairs.
 */
export async function getCheckRuns(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
): Promise<ExecFnResult & { checks: CheckRun[] }> {
	const result = await gh(exec, cwd, [
		"pr", "view",
		String(prNumber),
		"--json", "statusCheckRollup",
		"-q", '.statusCheckRollup[] | {name: (.name // .context), status: .status, conclusion: (.conclusion // .state)}',
	]);
	if (result.code !== 0) {
		return { ...result, checks: [] };
	}
	const raw = result.stdout.trim();
	if (!raw) return { ...result, checks: [] };
	try {
		const parsed = JSON.parse(`[${raw.split("\n").map((line) => line.trim()).filter(Boolean).join(",")}]`);
		return {
			...result,
			checks: parsed.map((c: RawCheck) => ({
				name: c.name ?? "unknown",
				status: normalizeStatus(c.status ?? "pending"),
				conclusion: c.conclusion ? normalizeStatus(c.conclusion) : null,
			})),
		};
	} catch {
		// Fallback: try as a single object.
		try {
			const parsed = JSON.parse(raw);
			return {
				...result,
				checks: [{ name: parsed.name ?? "unknown", status: normalizeStatus(parsed.status ?? "pending"), conclusion: parsed.conclusion ? normalizeStatus(parsed.conclusion) : null }],
			};
		} catch {
			return { ...result, checks: [] };
		}
	}
}

/** Map a raw gh status/conclusion string to the union type, defaulting to "pending". */
function normalizeStatus(value: string): CheckRun["status"] {
	const v = value.toLowerCase();
	if (v === "success") return "success";
	if (v === "failure") return "failure";
	if (v === "skipped") return "skipped";
	if (v === "neutral") return "neutral";
	return "pending";
}

interface RawCheck {
	name?: string;
	status?: string;
	conclusion?: string;
}

/** Check whether the PR head has conflicts against its base. */
export async function checkConflicts(exec: ExecFn, cwd: string, prNumber: number): Promise<ExecFnResult & { hasConflicts: boolean }> {
	const result = await gh(exec, cwd, [
		"pr", "view",
		String(prNumber),
		"--json", "mergeable",
		"-q", ".mergeable",
	]);
	if (result.code !== 0) {
		return { ...result, hasConflicts: false };
	}
	const mergeable = result.stdout.trim();
	return { ...result, hasConflicts: mergeable === "false" };
}

/**
 * Check whether the PR's base branch has fallen behind trunk (stale base).
 * Compares the PR base SHA against the current default branch HEAD.
 */
export async function checkStaleBase(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
): Promise<ExecFnResult & { isStale: boolean }> {
	const result = await gh(exec, cwd, [
		"pr", "view",
		String(prNumber),
		"--json", "baseRefName,baseRepository.nameWithOwner",
		"-q", ".baseRefName",
	]);
	if (result.code !== 0) {
		return { ...result, isStale: false };
	}
	const baseRef = result.stdout.trim();
	const defaultBranchResult = await gh(exec, cwd, ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
	if (defaultBranchResult.code !== 0) {
		return { ...result, isStale: false };
	}
	const defaultBranch = defaultBranchResult.stdout.trim();

	// If the base branch is not an ancestor of the default branch, the base
	// is stale (trunk has moved forward since the PR was branched or last
	// rebased onto it).
	const baseShaResult = await gh(exec, cwd, [
		"api",
		`repos/{owner}/{repo}/branches/${baseRef}`,
		"--jq", ".commit.sha",
	]);
	const defaultShaResult = await gh(exec, cwd, [
		"api",
		`repos/{owner}/{repo}/branches/${defaultBranch}`,
		"--jq", ".commit.sha",
	]);

	if (baseShaResult.code !== 0 || defaultShaResult.code !== 0) {
		return { ...result, isStale: false };
	}

	const baseSha = baseShaResult.stdout.trim();
	const defaultSha = defaultShaResult.stdout.trim();

	if (!baseSha || !defaultSha || baseSha === defaultSha) {
		return { ...result, isStale: false };
	}

	// Compare base vs default: "behind" means the base is stale.
	const ancestry = await gh(exec, cwd, [
		"api",
		`repos/{owner}/{repo}/compare/${baseSha}...${defaultSha}`,
		"--jq", ".status",
	]);
	const status = ancestry.stdout.trim();
	return { ...result, isStale: status === "behind" || status === "diverged" };
}

/** Check whether the PR is behind its base (has merge conflicts). */
export async function isMergeable(exec: ExecFn, cwd: string, prNumber: number): Promise<{ mergeable: boolean; conflicting: boolean }> {
	const result = await gh(exec, cwd, [
		"pr", "view",
		String(prNumber),
		"--json", "mergeable",
		"-q", ".mergeable",
	]);
	if (result.code !== 0) {
		return { mergeable: false, conflicting: result.stdout.trim() === "false" };
	}
	const m = result.stdout.trim();
	return { mergeable: m === "true" || m === "unknown", conflicting: m === "false" };
}

/**
 * Post a comment on a PR. Used for reporting blockers that the babysitter
 * does not auto-resolve (e.g. conflicts that need a rebase).
 */
export async function postPRComment(exec: ExecFn, cwd: string, prNumber: number, body: string): Promise<ExecFnResult> {
	return gh(exec, cwd, ["pr", "comment", String(prNumber), "--body", body]);
}

/** Get the current Git branch name in a working tree. */
export async function currentBranch(exec: ExecFn, cwd: string): Promise<ExecFnResult & { branch?: string }> {
	const result = await exec("git", ["branch", "--show-current"], { cwd, timeout: 5_000 });
	if (result.code !== 0) return { ...result, branch: undefined };
	return { ...result, branch: result.stdout.trim() || undefined };
}

/** Get the current Git HEAD SHA. */
export async function currentHead(exec: ExecFn, cwd: string): Promise<ExecFnResult & { sha?: string }> {
	const result = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
	if (result.code !== 0) return { ...result, sha: undefined };
	const sha = result.stdout.trim();
	return /^[0-9a-f]{40}$/.test(sha) ? { ...result, sha } : { ...result, sha: undefined };
}
