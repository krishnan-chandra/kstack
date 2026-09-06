/**
 * GitHub API interactions via the authenticated `gh` CLI.
 *
 * Every public function is a thin, typed wrapper around `gh` — no raw HTTP,
 * no embedded tokens. Credentials are owned by `gh`; they are never extracted,
 * logged, or embedded in arguments. All calls are bounded by timeout and
 * output caps.
 */

import { mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import { ghExec as gh, resolveRepoNameResult } from "../shared/github.ts";
import {
	autopilotReplyBody,
	clipLog,
	type GHPrJson,
	type GraphqlPage,
	type GraphqlThread,
	graphqlThreadToReviewThread,
	issueCommentToThread,
	parseGHPr,
	parseIssueComments,
	parsePrChecksJson,
	parseReviewThreadPage,
	parseReviewThreadsPage,
	pickLowestPrNumber,
	splitRepo,
} from "./github-parse.ts";
import type { CheckRun, ExecFn, ExecFnResult, ReviewThread } from "./types.ts";
import { LIMITS } from "./types.ts";

const REVIEW_COMMENT_FIELDS = `
  id
  databaseId
  body
  updatedAt
  path
  line
  url
  author { login }
`;

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 20) {
            pageInfo { hasNextPage endCursor }
            nodes { ${REVIEW_COMMENT_FIELDS} }
          }
        }
      }
    }
  }
}`;

const REVIEW_THREAD_QUERY = `query($id: ID!, $pageSize: Int!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id
      isResolved
      comments(first: $pageSize, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${REVIEW_COMMENT_FIELDS} }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) {
    thread { isResolved }
  }
}`;

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
			stderr: `Could not parse gh pr view output: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (error as Error).message}`,
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
	signal?: AbortSignal,
): Promise<ExecFnResult & { page?: GraphqlPage }> {
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
	const result = await gh(exec, cwd, args, 20_000, signal);
	if (result.code !== 0) return result;
	try {
		const parsed = parseReviewThreadsPage(JSON.parse(result.stdout.trim() || "{}"));
		if (!parsed.ok) return { code: 1, stdout: "", stderr: parsed.error };
		return { ...result, page: parsed.value };
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: `Could not parse review threads: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (error as Error).message}`,
		};
	}
}

async function fetchReviewThreadNodePage(
	exec: ExecFn,
	cwd: string,
	threadId: string,
	cursor: string | undefined,
	signal?: AbortSignal,
): Promise<ExecFnResult & { thread?: GraphqlThread; nodeAbsent?: boolean }> {
	const pageSize = cursor === undefined ? 20 : 100;
	const args = [
		"api",
		"graphql",
		"-f",
		`query=${REVIEW_THREAD_QUERY}`,
		"-F",
		`id=${threadId}`,
		"-F",
		`pageSize=${pageSize}`,
	];
	if (cursor !== undefined) args.push("-F", `cursor=${cursor}`);
	const result = await gh(exec, cwd, args, 20_000, signal);
	if (result.code !== 0) return result;
	try {
		const parsed = parseReviewThreadPage(JSON.parse(result.stdout.trim() || "{}"));
		if (!parsed.ok) return { code: 1, stdout: "", stderr: parsed.error };
		if (parsed.value === undefined) return { ...result, nodeAbsent: true };
		return { ...result, thread: parsed.value };
	} catch (error) {
		return {
			code: 1,
			stdout: "",
			stderr: `Could not parse review thread ${threadId}: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (error as Error).message}`,
		};
	}
}

interface CommentBudget {
	total: number;
}

type CompletedThread =
	| { ok: true; kind: "complete"; thread: GraphqlThread; last: ExecFnResult }
	| { ok: true; kind: "resolved" | "absent"; last: ExecFnResult }
	| { ok: false; error: ExecFnResult };

async function completeReviewThread(
	exec: ExecFn,
	cwd: string,
	initial: GraphqlThread,
	budget: CommentBudget,
	initialResult: ExecFnResult,
	signal?: AbortSignal,
): Promise<CompletedThread> {
	if (initial.isResolved) return { ok: true, kind: "resolved", last: initialResult };
	const comments = [...initial.commentPage.comments];
	const commentIds = new Set<string>();
	for (const comment of comments) {
		if (commentIds.has(comment.id)) {
			return {
				ok: false,
				error: { code: 1, stdout: "", stderr: `Review thread ${initial.id} repeated comment ${comment.id}.` },
			};
		}
		commentIds.add(comment.id);
	}
	budget.total += comments.length;
	if (comments.length > LIMITS.reviewCommentsPerThread || budget.total > LIMITS.reviewCommentsPerFetch) {
		return {
			ok: false,
			error: { code: 1, stdout: "", stderr: `Review comment limits were exceeded while reading thread ${initial.id}.` },
		};
	}

	let page = initial.commentPage;
	let last = initialResult;
	const cursors = new Set<string>();
	while (page.hasNextPage) {
		if (signal?.aborted) return { ok: false, error: { code: 130, stdout: "", stderr: "aborted" } };
		const cursor = page.endCursor;
		if (!cursor || cursors.has(cursor)) {
			return {
				ok: false,
				error: { code: 1, stdout: "", stderr: `Review thread ${initial.id} returned a missing or repeated cursor.` },
			};
		}
		if (comments.length >= LIMITS.reviewCommentsPerThread) {
			return {
				ok: false,
				error: {
					code: 1,
					stdout: "",
					stderr: `Review thread ${initial.id} still has comments after the ${LIMITS.reviewCommentsPerThread}-comment limit.`,
				},
			};
		}
		cursors.add(cursor);
		const fetched = await fetchReviewThreadNodePage(exec, cwd, initial.id, cursor, signal);
		last = fetched;
		if (fetched.code !== 0) return { ok: false, error: fetched };
		if (fetched.nodeAbsent) return { ok: true, kind: "absent", last };
		if (!fetched.thread || fetched.thread.id !== initial.id) {
			return {
				ok: false,
				error: { code: 1, stdout: "", stderr: `Review thread ${initial.id} returned a mismatched node.` },
			};
		}
		if (fetched.thread.isResolved) return { ok: true, kind: "resolved", last };
		for (const comment of fetched.thread.commentPage.comments) {
			if (commentIds.has(comment.id)) {
				return {
					ok: false,
					error: { code: 1, stdout: "", stderr: `Review thread ${initial.id} repeated comment ${comment.id}.` },
				};
			}
			commentIds.add(comment.id);
			comments.push(comment);
			budget.total++;
			if (comments.length > LIMITS.reviewCommentsPerThread || budget.total > LIMITS.reviewCommentsPerFetch) {
				return {
					ok: false,
					error: {
						code: 1,
						stdout: "",
						stderr: `Review comment limits were exceeded while reading thread ${initial.id}.`,
					},
				};
			}
		}
		page = fetched.thread.commentPage;
	}
	return {
		ok: true,
		kind: "complete",
		thread: { ...initial, commentPage: { comments, hasNextPage: false } },
		last,
	};
}

export async function getReviewThreads(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	repo?: string,
	signal?: AbortSignal,
): Promise<ExecFnResult & { threads: ReviewThread[] }> {
	const repoResult =
		repo !== undefined ? { code: 0, stdout: repo, stderr: "", repo } : await resolveRepoNameResult(exec, cwd, signal);
	const split = repoResult.repo ? splitRepo(repoResult.repo) : undefined;
	if (!split) {
		const reason = repoResult.stderr.trim() || "GitHub CLI returned an invalid repository identity.";
		return {
			code: 1,
			stdout: "",
			stderr: `Could not resolve GitHub repository for review threads: ${reason}`,
			threads: [],
		};
	}

	const threads: ReviewThread[] = [];
	const threadIds = new Set<string>();
	const cursors = new Set<string>();
	const budget = { total: 0 };
	let cursor: string | undefined;
	let last: ExecFnResult = repoResult;
	for (let pageIndex = 0; pageIndex < LIMITS.reviewThreadPages; pageIndex++) {
		if (signal?.aborted) return { code: 130, stdout: "", stderr: "aborted", threads };
		const fetched = await fetchReviewThreadPage(exec, cwd, split.owner, split.name, prNumber, cursor, signal);
		last = fetched;
		if (fetched.code !== 0 || !fetched.page) return { ...fetched, threads };
		for (const node of fetched.page.threads) {
			if (threadIds.has(node.id)) {
				return { code: 1, stdout: "", stderr: `Review thread ${node.id} was repeated.`, threads };
			}
			threadIds.add(node.id);
			if (node.isResolved) continue;
			const completed = await completeReviewThread(exec, cwd, node, budget, fetched, signal);
			if (!completed.ok) return { ...completed.error, threads };
			last = completed.last;
			if (completed.kind !== "complete") continue;
			const mapped = graphqlThreadToReviewThread(completed.thread);
			if (mapped) threads.push(mapped);
		}
		if (!fetched.page.hasNextPage) return { ...last, threads };
		const nextCursor = fetched.page.endCursor;
		if (!nextCursor || cursors.has(nextCursor)) {
			return { code: 1, stdout: "", stderr: "Review threads returned a missing or repeated cursor.", threads };
		}
		cursors.add(nextCursor);
		cursor = nextCursor;
	}
	return {
		code: 1,
		stdout: "",
		stderr: `Review threads still have data after the ${LIMITS.reviewThreadPages}-page limit.`,
		threads,
	};
}

type ReviewThreadObservation = { kind: "absent" } | { kind: "resolved" } | { kind: "unresolved"; thread: ReviewThread };

/** Read one complete thread immediately before resolution. */
export async function getReviewThread(
	exec: ExecFn,
	cwd: string,
	threadId: string,
	signal?: AbortSignal,
): Promise<ExecFnResult & { observation?: ReviewThreadObservation }> {
	if (signal?.aborted) return { code: 130, stdout: "", stderr: "aborted" };
	const fetched = await fetchReviewThreadNodePage(exec, cwd, threadId, undefined, signal);
	if (fetched.code !== 0) return fetched;
	if (fetched.nodeAbsent) return { ...fetched, observation: { kind: "absent" } };
	if (!fetched.thread || fetched.thread.id !== threadId) {
		return { code: 1, stdout: "", stderr: `Review thread ${threadId} returned a mismatched node.` };
	}
	const completed = await completeReviewThread(exec, cwd, fetched.thread, { total: 0 }, fetched, signal);
	if (!completed.ok) return completed.error;
	if (completed.kind !== "complete") {
		return { ...completed.last, observation: { kind: completed.kind } };
	}
	const thread = graphqlThreadToReviewThread(completed.thread);
	if (!thread) {
		return { code: 1, stdout: "", stderr: `Review thread ${threadId} has no represented feedback.` };
	}
	return { ...completed.last, observation: { kind: "unresolved", thread } };
}

export async function getIssueComments(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	repo?: string,
): Promise<ExecFnResult & { threads: ReviewThread[] }> {
	const repository = repo ?? "{owner}/{repo}";
	if (repo !== undefined && !splitRepo(repo)) {
		return { code: 1, stdout: "", stderr: "Invalid explicit repository for issue comments.", threads: [] };
	}
	const result = await gh(exec, cwd, [
		"api",
		`repos/${repository}/issues/${prNumber}/comments`,
		"--method",
		"GET",
		"--paginate",
		"--slurp",
	]);
	if (result.code !== 0) return { ...result, threads: [] };
	const parsed = parseIssueComments(result.stdout.trim() || "[]");
	if (!parsed.ok) return { code: 1, stdout: "", stderr: parsed.error, threads: [] };
	return { ...result, threads: parsed.value.map(issueCommentToThread) };
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

/** Attach one capped failed-log excerpt per distinct Actions run, in parallel. */
export async function attachFailedLogs(
	exec: ExecFn,
	cwd: string,
	checks: CheckRun[],
	concurrency: number,
): Promise<CheckRun[]> {
	const runIds = [
		...new Set(checks.flatMap((check) => (check.conclusion === "failure" && check.runId ? [check.runId] : []))),
	];
	if (runIds.length === 0) return checks;
	const logsByRunId = new Map(
		await mapWithConcurrencyLimit(
			runIds,
			concurrency,
			async (runId): Promise<[string, string | undefined]> => [runId, await fetchFailedLog(exec, cwd, runId)],
		),
	);
	return checks.map((check) => {
		if (check.conclusion !== "failure" || !check.runId) return check;
		const logExcerpt = logsByRunId.get(check.runId);
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
			stderr: signal?.aborted
				? "aborted"
				: /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (error as Error)
						.message,
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
	repo?: string,
): Promise<ExecFnResult> {
	const repository = repo ?? "{owner}/{repo}";
	if (repo !== undefined && !splitRepo(repo)) {
		return { code: 1, stdout: "", stderr: "Invalid explicit repository for review reply." };
	}
	return gh(exec, cwd, [
		"api",
		`repos/${repository}/pulls/${prNumber}/comments`,
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
