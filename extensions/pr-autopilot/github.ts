/**
 * GitHub API interactions via the authenticated `gh` CLI.
 *
 * Every public function is a thin, typed wrapper around `gh` — no raw HTTP,
 * no embedded tokens. Credentials are owned by `gh`; they are never extracted,
 * logged, or embedded in arguments. All calls are bounded by timeout and
 * output caps.
 */

import { mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import type { CheckRun, ExecFn, ExecFnResult, MergeStateStatus, ReviewThread } from "./types.ts";
import { LIMITS } from "./types.ts";

const AUTOPILOT_REPLY_MARKER = "<!-- pr-autopilot -->";
const LEGACY_REPLY_MARKER = "<!-- pr-babysit -->";

function autopilotReplyBody(body: string): string {
	if (body.includes(AUTOPILOT_REPLY_MARKER)) return body;
	return `${AUTOPILOT_REPLY_MARKER}\n${body}`;
}

function isAutopilotReply(body: string): boolean {
	return body.includes(AUTOPILOT_REPLY_MARKER) || body.includes(LEGACY_REPLY_MARKER);
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

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

function splitRepo(repo: string): { owner: string; name: string } | undefined {
	const slash = repo.indexOf("/");
	if (slash <= 0 || slash === repo.length - 1) return undefined;
	return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

/** Parse `gh pr list --json number` and return the lowest number. */
export function pickLowestPrNumber(stdout: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const numbers: number[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) continue;
		const n = asNumber(item.number);
		if (n !== undefined && Number.isInteger(n) && n >= 1) numbers.push(n);
	}
	if (numbers.length === 0) return undefined;
	numbers.sort((a, b) => a - b);
	return numbers[0];
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

export function parseMergeStateStatus(raw: unknown): MergeStateStatus {
	if (typeof raw !== "string") return "UNKNOWN";
	switch (raw.toUpperCase()) {
		case "CLEAN":
			return "CLEAN";
		case "DIRTY":
			return "DIRTY";
		case "BEHIND":
			return "BEHIND";
		case "BLOCKED":
			return "BLOCKED";
		case "DRAFT":
			return "DRAFT";
		case "UNSTABLE":
			return "UNSTABLE";
		case "HAS_HOOKS":
			return "HAS_HOOKS";
		case "UNKNOWN":
			return "UNKNOWN";
		default:
			return "UNKNOWN";
	}
}

export interface GHPrJson {
	number: number;
	title: string;
	state: string;
	isDraft: boolean;
	mergeable: string;
	mergeStateStatus: MergeStateStatus;
	headRefName: string;
	baseRefName: string;
	headSha: string;
	commits?: Array<{ oid: string }>;
}

function parseGHPr(raw: unknown): GHPrJson | undefined {
	if (!isRecord(raw)) return undefined;
	const number = asNumber(raw.number);
	if (number === undefined || number < 1) return undefined;
	const headSha = asString(raw.headRefOid) ?? asString(raw.headSha) ?? "";
	return {
		number,
		title: asString(raw.title) ?? "",
		state: asString(raw.state) ?? "open",
		isDraft: asBoolean(raw.isDraft) ?? false,
		mergeable: asString(raw.mergeable) ?? "unknown",
		mergeStateStatus: parseMergeStateStatus(raw.mergeStateStatus),
		headRefName: asString(raw.headRefName) ?? "",
		baseRefName: asString(raw.baseRefName) ?? "",
		headSha,
		commits: Array.isArray(raw.commits)
			? raw.commits.flatMap((c) => {
					if (!isRecord(c)) return [];
					const oid = asString(c.oid);
					return oid ? [{ oid }] : [];
				})
			: [],
	};
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

interface GraphqlComment {
	databaseId?: number;
	body: string;
	path?: string;
	line?: number;
	url?: string;
	authorLogin: string;
}

interface GraphqlThread {
	id: string;
	isResolved: boolean;
	comments: GraphqlComment[];
}

interface GraphqlPage {
	threads: GraphqlThread[];
	hasNextPage: boolean;
	endCursor?: string;
}

function parseGraphqlComment(raw: unknown): GraphqlComment | undefined {
	if (!isRecord(raw)) return undefined;
	const body = typeof raw.body === "string" ? raw.body : "";
	const author = isRecord(raw.author) ? asString(raw.author.login) : undefined;
	const databaseId = asNumber(raw.databaseId);
	return {
		databaseId: databaseId !== undefined && Number.isInteger(databaseId) ? databaseId : undefined,
		body,
		path: asString(raw.path),
		line: asNumber(raw.line),
		url: asString(raw.url),
		authorLogin: author ?? "unknown",
	};
}

/** Parse one page of the reviewThreads GraphQL response. */
export function parseReviewThreadsPage(raw: unknown): GraphqlPage {
	if (!isRecord(raw)) return { threads: [], hasNextPage: false };
	const data = isRecord(raw.data) ? raw.data : raw;
	const repository = isRecord(data.repository) ? data.repository : undefined;
	const pullRequest = repository && isRecord(repository.pullRequest) ? repository.pullRequest : undefined;
	const reviewThreads = pullRequest && isRecord(pullRequest.reviewThreads) ? pullRequest.reviewThreads : undefined;
	if (!reviewThreads) return { threads: [], hasNextPage: false };
	const pageInfo = isRecord(reviewThreads.pageInfo) ? reviewThreads.pageInfo : undefined;
	const nodes = Array.isArray(reviewThreads.nodes) ? reviewThreads.nodes : [];
	const threads: GraphqlThread[] = [];
	for (const node of nodes) {
		if (!isRecord(node)) continue;
		const id = asString(node.id);
		if (!id) continue;
		const commentsRaw = isRecord(node.comments) && Array.isArray(node.comments.nodes) ? node.comments.nodes : [];
		const comments = commentsRaw.flatMap((c) => {
			const parsed = parseGraphqlComment(c);
			return parsed ? [parsed] : [];
		});
		threads.push({
			id,
			isResolved: asBoolean(node.isResolved) === true,
			comments,
		});
	}
	return {
		threads,
		hasNextPage: asBoolean(pageInfo?.hasNextPage) === true,
		endCursor: asString(pageInfo?.endCursor),
	};
}

export function graphqlThreadToReviewThread(thread: GraphqlThread): ReviewThread | undefined {
	if (thread.isResolved || thread.comments.length === 0) return undefined;
	const first = thread.comments[0];
	const last = thread.comments[thread.comments.length - 1];
	return {
		id: thread.id,
		commenter: last.authorLogin || first.authorLogin,
		body: last.body || first.body,
		path: first.path ?? last.path,
		line: first.line ?? last.line,
		url: last.url ?? first.url,
		replyToId: last.databaseId ?? first.databaseId,
		source: "review-thread",
	};
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

interface RawIssueComment {
	id: number;
	commenter: string;
	body: string;
	url?: string;
}

export function parseIssueComments(stdout: string): RawIssueComment[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const items: unknown[] = parsed.every(Array.isArray) ? parsed.flat() : parsed;
	const comments: RawIssueComment[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const id = asNumber(item.id);
		if (id === undefined || !Number.isInteger(id) || id < 1) continue;
		const user = isRecord(item.user) ? asString(item.user.login) : asString(item.commenter);
		const body = typeof item.body === "string" ? item.body : "";
		if (isAutopilotReply(body)) continue;
		comments.push({
			id,
			commenter: user ?? "unknown",
			body,
			url: asString(item.html_url) ?? asString(item.url),
		});
	}
	return comments.slice(-LIMITS.issueComments);
}

export function issueCommentToThread(comment: RawIssueComment): ReviewThread {
	return {
		id: `issue-comment-${comment.id}`,
		commenter: comment.commenter,
		body: comment.body,
		url: comment.url,
		replyToId: comment.id,
		source: "issue-comment",
	};
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

/** Extract a GitHub Actions run id from a check details URL. */
export function extractRunId(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const match = url.match(/\/actions\/runs\/(\d+)/);
	return match ? match[1] : undefined;
}

export function clipLog(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let out = buf.subarray(buf.length - maxBytes).toString("utf8");
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(1);
	return out;
}

function parseCheckState(state: string | undefined, bucket: string | undefined): CheckRun["status"] {
	const token = (bucket ?? state ?? "pending").toLowerCase();
	if (token === "pass" || token === "success") return "success";
	if (token === "fail" || token === "failure" || token === "error") return "failure";
	if (token === "skipping" || token === "skipped") return "skipped";
	if (token === "cancel" || token === "cancelled") return "cancelled";
	if (token === "neutral") return "neutral";
	return "pending";
}

export function parsePrChecksJson(stdout: string): CheckRun[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const checks: CheckRun[] = [];
	for (const row of rows) {
		if (!isRecord(row)) continue;
		const name = asString(row.name) ?? asString(row.workflow) ?? "unknown";
		const status = parseCheckState(asString(row.state), asString(row.bucket));
		const detailsUrl = asString(row.link) ?? asString(row.detailsUrl);
		checks.push({
			name,
			status,
			conclusion: status === "pending" ? null : status,
			detailsUrl,
			runId: extractRunId(detailsUrl),
		});
	}
	return checks;
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

export async function currentBranch(exec: ExecFn, cwd: string): Promise<ExecFnResult & { branch?: string }> {
	const result = await exec("git", ["branch", "--show-current"], { cwd, timeout: 5_000 });
	if (result.code !== 0) return { ...result, branch: undefined };
	return { ...result, branch: result.stdout.trim() || undefined };
}

export async function currentHead(
	exec: ExecFn,
	cwd: string,
	timeout = 5_000,
): Promise<ExecFnResult & { sha?: string }> {
	const result = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout });
	if (result.code !== 0) return { ...result, sha: undefined };
	const sha = result.stdout.trim();
	return /^[0-9a-f]{40}$/.test(sha) ? { ...result, sha } : { ...result, sha: undefined };
}

export function parsePorcelainPaths(stdout: string): string[] {
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length < 4) continue;
		const rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		const path = (arrow === -1 ? rest : rest.slice(arrow + 4)).trim();
		if (path) paths.push(path);
	}
	return paths;
}

export function isForbiddenStagingPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	const base = normalized.split("/").pop() ?? normalized;
	if (base === ".env" || base.startsWith(".env.") || base === "credentials.json") return true;
	if (normalized.includes(".github/workflows/")) return true;
	if (base.endsWith(".pem") || base === "id_rsa" || base === "id_ed25519") return true;
	return false;
}

type MergeBaseResult =
	| { kind: "clean"; headSha: string }
	| { kind: "already-current" }
	| { kind: "needs-human"; files: string[]; error: string }
	| { kind: "failed"; error: string };

/**
 * Merge origin/<base> into the frontier head. Never rebases. Aborts if hunks
 * have competing intents (git reports conflicts).
 */
export async function mergeBaseIntoHead(exec: ExecFn, cwd: string, baseRef: string): Promise<MergeBaseResult> {
	const fetch = await exec("git", ["fetch", "origin", baseRef], { cwd, timeout: 60_000 });
	if (fetch.code !== 0) return { kind: "failed", error: `git fetch origin ${baseRef} failed: ${fetch.stderr.trim()}` };

	const merge = await exec("git", ["merge", "--no-edit", `origin/${baseRef}`], { cwd, timeout: 30_000 });
	if (merge.code === 0) {
		const already = /Already up to date/i.test(merge.stdout);
		if (already) return { kind: "already-current" };
		const head = await currentHead(exec, cwd);
		if (!head.sha) return { kind: "failed", error: "merge succeeded but HEAD SHA could not be read." };
		return { kind: "clean", headSha: head.sha };
	}

	const unmerged = await exec("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, timeout: 5_000 });
	const files = unmerged.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	await exec("git", ["merge", "--abort"], { cwd, timeout: 10_000 });
	return {
		kind: "needs-human",
		files,
		error:
			files.length > 0
				? `Merge of origin/${baseRef} conflicted in ${files.join(", ")}. Competing intents need a human.`
				: `git merge origin/${baseRef} failed: ${merge.stderr.trim() || merge.stdout.trim()}`,
	};
}

/**
 * Integrate the latest remote of the PR branch before committing. Never force-push.
 */
export async function integrateRemoteHead(
	exec: ExecFn,
	cwd: string,
	headRef: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const fetch = await exec("git", ["fetch", "origin", headRef], { cwd, timeout: 60_000 });
	if (fetch.code !== 0) return { ok: false, error: `git fetch origin ${headRef} failed: ${fetch.stderr.trim()}` };

	const ff = await exec("git", ["merge", "--ff-only", `origin/${headRef}`], { cwd, timeout: 15_000 });
	if (ff.code === 0) return { ok: true };

	const merge = await exec("git", ["merge", "--no-edit", `origin/${headRef}`], { cwd, timeout: 30_000 });
	if (merge.code === 0) return { ok: true };

	await exec("git", ["merge", "--abort"], { cwd, timeout: 10_000 });
	return { ok: false, error: `Could not integrate origin/${headRef} without a rebase. ${merge.stderr.trim()}` };
}
