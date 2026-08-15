/**
 * GitHub API interactions via the authenticated `gh` CLI.
 *
 * Every public function is a thin, typed wrapper around `gh` — no raw HTTP,
 * no embedded tokens. Credentials are owned by `gh`; they are never extracted,
 * logged, or embedded in arguments. All calls are bounded by timeout and
 * output caps.
 */

import { mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import {
	autopilotReplyBody,
	clipLog,
	type GHPrJson,
	type GraphqlPage,
	graphqlThreadToReviewThread,
	issueCommentToThread,
	parseGHPr,
	parseIssueComments,
	parsePrChecksJson,
	parseReviewThreadsPage,
	pickLowestPrNumber,
	splitRepo,
} from "./github-parse.ts";
import type { CheckRun, ExecFn, ExecFnResult, ReviewThread } from "./types.ts";
import { LIMITS } from "./types.ts";

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 20) {
            nodes {
              databaseId
              body
              path
              line
              url
              author { login }
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread { isResolved }
  }
}`;

/** Run a gh command and return its result. */
export async function gh(exec: ExecFn, cwd: string, args: string[], timeout = 15_000): Promise<ExecFnResult> {
	try {
		return await exec("gh", args, { cwd, timeout });
	} catch (error) {
		return { code: 1, stdout: "", stderr: (error as Error).message };
	}
}

/** Resolve the repo owner/name for the current checkout. */
async function resolveRepo(exec: ExecFn, cwd: string): Promise<ExecFnResult & { repo?: string }> {
	const result = await gh(exec, cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
	if (result.code !== 0 || !result.stdout.trim()) {
		return { ...result, repo: undefined };
	}
	const repo = result.stdout.trim();
	return /^[^/\s]+\/[^/\s]+$/.test(repo) ? { ...result, repo } : { ...result, repo: undefined };
}

/**
 * Fetch the lowest unmerged open PR in the current repository, sorted by
 * number ascending. Returns nothing when no open PR exists.
 */
export async function findLowestUnmergedPR(exec: ExecFn, cwd: string): Promise<ExecFnResult & { prNumber?: number }> {
	const result = await gh(exec, cwd, [
		"pr",
		"list",
		"--state",
		"open",
		"--author",
		"@me",
		"--limit",
		"50",
		"--json",
		"number",
	]);
	if (result.code !== 0) {
		return { ...result, prNumber: undefined };
	}
	return { ...result, prNumber: pickLowestPrNumber(result.stdout.trim()) };
}

/**
 * Fetch a comprehensive PR state snapshot. Returns parsed JSON with the
 * fields needed by the autopilot: number, title, draft, mergeability,
 * head SHA, base ref, and commit SHAs.
 */
export async function viewPR(exec: ExecFn, cwd: string, prNumber: number): Promise<ExecFnResult & { pr?: GHPrJson }> {
	const fields = "number,title,state,isDraft,mergeable,mergeStateStatus,headRefName,baseRefName,headRefOid,commits";
	const result = await gh(exec, cwd, ["pr", "view", String(prNumber), "--json", fields, "-q", "."]);
	if (result.code !== 0 || !result.stdout.trim()) {
		return { ...result, pr: undefined };
	}
	try {
		const pr = parseGHPr(JSON.parse(result.stdout.trim()));
		if (!pr) return { ...result, pr: undefined };
		return { ...result, pr };
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: `Could not parse gh pr view output: ${(error as Error).message}`,
			pr: undefined,
		};
	}
}

async function fetchReviewThreadPage(
	exec: ExecFn,
	cwd: string,
	owner: string,
	name: string,
	prNumber: number,
	cursor: string | undefined,
): Promise<ExecFnResult & { page: GraphqlPage }> {
	const args = [
		"api",
		"graphql",
		"-f",
		`query=${REVIEW_THREADS_QUERY}`,
		"-F",
		`owner=${owner}`,
		"-F",
		`name=${name}`,
		"-F",
		`number=${prNumber}`,
	];
	if (cursor) args.push("-F", `cursor=${cursor}`);
	const result = await gh(exec, cwd, args, 20_000);
	if (result.code !== 0) {
		return { ...result, page: { threads: [], hasNextPage: false } };
	}
	try {
		return { ...result, page: parseReviewThreadsPage(JSON.parse(result.stdout.trim() || "{}")) };
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: `Could not parse review threads: ${(error as Error).message}`,
			page: { threads: [], hasNextPage: false },
		};
	}
}

export async function getReviewThreads(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
): Promise<ExecFnResult & { threads: ReviewThread[] }> {
	const repoResult = await resolveRepo(exec, cwd);
	if (!repoResult.repo) {
		return { ...repoResult, threads: [] };
	}
	const split = splitRepo(repoResult.repo);
	if (!split) return { ...repoResult, threads: [] };

	const threads: ReviewThread[] = [];
	let cursor: string | undefined;
	let last: ExecFnResult = repoResult;
	for (let page = 0; page < 20; page++) {
		const fetched = await fetchReviewThreadPage(exec, cwd, split.owner, split.name, prNumber, cursor);
		last = fetched;
		if (fetched.code !== 0) return { ...fetched, threads };
		for (const node of fetched.page.threads) {
			const mapped = graphqlThreadToReviewThread(node);
			if (mapped) threads.push(mapped);
		}
		if (!fetched.page.hasNextPage || !fetched.page.endCursor) break;
		cursor = fetched.page.endCursor;
	}
	return { ...last, threads };
}

export async function getIssueComments(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
): Promise<ExecFnResult & { threads: ReviewThread[] }> {
	const result = await gh(exec, cwd, [
		"api",
		`repos/{owner}/{repo}/issues/${prNumber}/comments`,
		"--method",
		"GET",
		"--paginate",
		"--slurp",
	]);
	if (result.code !== 0) return { ...result, threads: [] };
	return { ...result, threads: parseIssueComments(result.stdout.trim() || "[]").map(issueCommentToThread) };
}

/**
 * Fetch check runs (CI status) for a PR. Uses `gh pr checks` as the source of
 * truth (includes non-Actions checks that `gh run list` misses).
 */
export async function getCheckRuns(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
): Promise<ExecFnResult & { checks: CheckRun[] }> {
	const result = await gh(
		exec,
		cwd,
		["pr", "checks", String(prNumber), "--json", "name,state,bucket,workflow,link"],
		20_000,
	);
	if (result.code !== 0) {
		return { ...result, checks: [] };
	}
	return { ...result, checks: parsePrChecksJson(result.stdout) };
}

async function fetchFailedLog(exec: ExecFn, cwd: string, runId: string): Promise<string | undefined> {
	const result = await gh(exec, cwd, ["run", "view", runId, "--log-failed"], 30_000);
	if (result.code !== 0) return undefined;
	const text = result.stdout.trim();
	if (!text) return undefined;
	return clipLog(text, LIMITS.logExcerptBytes);
}

/** Attach capped failed-log excerpts to failing Actions checks, in parallel. */
export async function attachFailedLogs(
	exec: ExecFn,
	cwd: string,
	checks: CheckRun[],
	concurrency: number,
): Promise<CheckRun[]> {
	const failing = checks.filter((c) => c.conclusion === "failure" && c.runId);
	if (failing.length === 0) return checks;
	const logs = await mapWithConcurrencyLimit(failing, concurrency, async (check) => {
		const runId = check.runId;
		if (!runId) return { id: check.name, log: undefined };
		return { id: `${check.name}:${runId}`, log: await fetchFailedLog(exec, cwd, runId) };
	});
	const byKey = new Map<string, string | undefined>();
	for (let i = 0; i < failing.length; i++) {
		const check = failing[i];
		byKey.set(`${check.name}:${check.runId}`, logs[i]?.log);
	}
	return checks.map((check) => {
		if (check.conclusion !== "failure" || !check.runId) return check;
		const logExcerpt = byKey.get(`${check.name}:${check.runId}`);
		return logExcerpt ? { ...check, logExcerpt } : check;
	});
}

export async function watchChecks(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ExecFnResult> {
	try {
		return await exec("gh", ["pr", "checks", String(prNumber), "--watch", "--fail-fast"], {
			cwd,
			timeout: timeoutMs,
			signal,
		});
	} catch (error) {
		return {
			code: signal?.aborted ? 130 : 1,
			stdout: "",
			stderr: signal?.aborted ? "aborted" : (error as Error).message,
		};
	}
}

export async function rerunFailedRun(exec: ExecFn, cwd: string, runId: string): Promise<ExecFnResult> {
	return gh(exec, cwd, ["run", "rerun", runId, "--failed"], 30_000);
}

export async function replyToReviewComment(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	inReplyTo: number,
	body: string,
): Promise<ExecFnResult> {
	return gh(exec, cwd, [
		"api",
		`repos/{owner}/{repo}/pulls/${prNumber}/comments`,
		"-f",
		`body=${autopilotReplyBody(body)}`,
		"-F",
		`in_reply_to=${inReplyTo}`,
	]);
}

export async function replyToIssueComment(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	body: string,
): Promise<ExecFnResult> {
	return gh(exec, cwd, ["pr", "comment", String(prNumber), "--body", autopilotReplyBody(body)]);
}

export async function resolveReviewThread(exec: ExecFn, cwd: string, threadId: string): Promise<ExecFnResult> {
	return gh(exec, cwd, ["api", "graphql", "-f", `query=${RESOLVE_THREAD_MUTATION}`, "-f", `id=${threadId}`]);
}

export async function markPrReady(exec: ExecFn, cwd: string, prNumber: number): Promise<ExecFnResult> {
	return gh(exec, cwd, ["pr", "ready", String(prNumber)]);
}

export function isForbiddenStagingPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	const base = normalized.split("/").pop() ?? normalized;
	if (base === ".env" || base.startsWith(".env.") || base === "credentials.json") return true;
	if (normalized.includes(".github/workflows/")) return true;
	if (base.endsWith(".pem") || base === "id_rsa" || base === "id_ed25519") return true;
	return false;
}
