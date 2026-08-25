import type { ExecFn, ExecFnResult } from "./git-exec.ts";
import { asRecord } from "./narrow.ts";
import { type BoundaryValue, isBoolean, isNumber, isString } from "./validation.ts";

/** Merge methods Kstack permits anywhere; merge commits are never allowed. */
export type MergeMethod = "squash" | "rebase";

export function isMergeMethod(value: BoundaryValue): value is MergeMethod {
	return value === "squash" || value === "rebase";
}

/** Marker identifying Kstack-owned PR navigation comments across extensions. */
export const KSTACK_COMMENT_MARKER = "<!-- kstack-stack-nav -->";

export interface RepositorySnapshot {
	nameWithOwner: string;
	defaultBranch: string;
	allowedMethods: MergeMethod[];
}

export interface PullRequestSnapshot {
	number: number;
	url: string;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
	headRef: string;
	baseRef: string;
	headOid: string;
	mergeable: string;
	mergeStateStatus: string;
	mergedAt: string | null;
	mergeCommitOid: string | null;
}

interface GithubLimits {
	queryMs: number;
	mergeMs: number;
	pollMs: number;
	landingMs: number;
	diagnosticsBytes: number;
}

const DEFAULT_LIMITS: GithubLimits = {
	queryMs: 15_000,
	mergeMs: 60_000,
	pollMs: 10_000,
	landingMs: 30 * 60_000,
	diagnosticsBytes: 8 * 1024,
};
const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY_NAME = /^[^/\s]+\/[^/\s]+$/;

/** Run a bounded GitHub CLI command without propagating execution failures. */
export async function ghExec(
	exec: ExecFn,
	cwd: string,
	args: string[],
	timeout = DEFAULT_LIMITS.queryMs,
	signal?: AbortSignal,
): Promise<ExecFnResult> {
	try {
		return await exec("gh", args, { cwd, timeout, signal });
	} catch (error) {
		return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

/** Resolve the current checkout's GitHub owner/name and preserve CLI diagnostics. */
export async function resolveRepoNameResult(
	exec: ExecFn,
	cwd: string,
	signal?: AbortSignal,
): Promise<ExecFnResult & { repo?: string }> {
	const result = await ghExec(
		exec,
		cwd,
		["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
		undefined,
		signal,
	);
	const repo = result.stdout.trim();
	return { ...result, repo: result.code === 0 && REPOSITORY_NAME.test(repo) ? repo : undefined };
}

/** Resolve the current checkout's GitHub owner/name, if available. */
export async function resolveRepoName(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	return (await resolveRepoNameResult(exec, cwd, signal)).repo;
}

function parseJson(text: string): BoundaryValue {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("GitHub CLI returned invalid JSON.");
	}
}

function diagnostic(text: string, maxBytes: number): string {
	return text.slice(0, maxBytes).trim();
}

function withDefaults(limits: Partial<GithubLimits>): GithubLimits {
	return { ...DEFAULT_LIMITS, ...limits };
}

export async function getRepository(
	exec: ExecFn,
	cwd: string,
	signal?: AbortSignal,
	limitOverrides: Partial<GithubLimits> = {},
): Promise<RepositorySnapshot> {
	const limits = withDefaults(limitOverrides);
	const out = await exec(
		"gh",
		["repo", "view", "--json", "nameWithOwner,defaultBranchRef,squashMergeAllowed,rebaseMergeAllowed"],
		{ cwd, timeout: limits.queryMs, signal },
	);
	if (out.code !== 0)
		throw new Error(
			`Could not resolve authenticated GitHub repository: ${diagnostic(out.stderr, limits.diagnosticsBytes)}`,
		);
	const value = asRecord(parseJson(out.stdout));
	const branch = asRecord(value?.defaultBranchRef);
	if (!isString(value?.nameWithOwner) || !isString(branch?.name))
		throw new Error("GitHub repository response is missing identity/default branch.");
	const allowedMethods: MergeMethod[] = [];
	// Kstack policy: merge commits are never allowed
	if (value.squashMergeAllowed === true) allowedMethods.push("squash");
	if (value.rebaseMergeAllowed === true) allowedMethods.push("rebase");
	return { nameWithOwner: value.nameWithOwner, defaultBranch: branch.name, allowedMethods };
}

export async function getPullRequest(
	exec: ExecFn,
	cwd: string,
	number: number,
	signal?: AbortSignal,
	limitOverrides: Partial<GithubLimits> = {},
): Promise<PullRequestSnapshot> {
	const limits = withDefaults(limitOverrides);
	const out = await exec(
		"gh",
		[
			"pr",
			"view",
			String(number),
			"--json",
			"number,url,title,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,mergedAt,mergeCommit",
		],
		{ cwd, timeout: limits.queryMs, signal },
	);
	if (out.code !== 0)
		throw new Error(`Could not read PR #${number}: ${diagnostic(out.stderr, limits.diagnosticsBytes)}`);
	const value = asRecord(parseJson(out.stdout));
	const commit = asRecord(value?.mergeCommit);
	if (
		value?.number !== number ||
		!isString(value.url) ||
		!isString(value.title) ||
		!["OPEN", "CLOSED", "MERGED"].includes(String(value.state)) ||
		!isBoolean(value.isDraft) ||
		!isString(value.headRefName) ||
		!isString(value.baseRefName) ||
		!isString(value.headRefOid) ||
		!SHA.test(value.headRefOid)
	)
		throw new Error(`PR #${number} response failed validation.`);
	return {
		number,
		url: value.url,
		title: value.title,
		state:
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ value.state as PullRequestSnapshot["state"],
		isDraft: value.isDraft,
		headRef: value.headRefName,
		baseRef: value.baseRefName,
		headOid: value.headRefOid,
		mergeable: String(value.mergeable),
		mergeStateStatus: String(value.mergeStateStatus),
		mergedAt: isString(value.mergedAt) ? value.mergedAt : null,
		mergeCommitOid: isString(commit?.oid) ? commit.oid : null,
	};
}

export async function findOpenPullRequestByHead(
	exec: ExecFn,
	cwd: string,
	headRef: string,
	signal?: AbortSignal,
	limitOverrides: Partial<GithubLimits> = {},
): Promise<number> {
	const limits = withDefaults(limitOverrides);
	const out = await exec("gh", ["pr", "list", "--state", "open", "--head", headRef, "--json", "number,headRefName"], {
		cwd,
		timeout: limits.queryMs,
		signal,
	});
	if (out.code !== 0)
		throw new Error(
			`Could not resolve an open PR for branch ${headRef}: ${diagnostic(out.stderr, limits.diagnosticsBytes)}`,
		);
	const value = parseJson(out.stdout);
	if (!Array.isArray(value)) throw new Error("GitHub PR list response failed validation.");
	const matches = value.filter((entry) => {
		const candidate = asRecord(entry);
		return candidate?.headRefName === headRef && Number.isSafeInteger(candidate.number) && Number(candidate.number) > 0;
	});
	if (matches.length !== 1)
		throw new Error(`Expected exactly one open PR with head ${headRef}; found ${matches.length}.`);
	const match = asRecord(matches[0]);
	if (!match || !isNumber(match.number)) throw new Error("GitHub PR list response failed validation.");
	return match.number;
}

export async function mergePullRequest(
	exec: ExecFn,
	cwd: string,
	number: number,
	method: MergeMethod,
	sha: string,
	signal?: AbortSignal,
	limitOverrides: Partial<GithubLimits> = {},
): Promise<void> {
	const limits = withDefaults(limitOverrides);
	const out = await exec("gh", ["pr", "merge", String(number), `--${method}`, "--match-head-commit", sha], {
		cwd,
		timeout: limits.mergeMs,
		signal,
	});
	if (out.code !== 0)
		throw new Error(
			`GitHub rejected merge for PR #${number}: ${diagnostic(out.stderr || out.stdout, limits.diagnosticsBytes)}`,
		);
}

export async function waitForMerge(
	exec: ExecFn,
	cwd: string,
	number: number,
	expectedRef: string,
	expectedSha: string,
	deps: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> },
	signal: AbortSignal,
	limitOverrides: Partial<GithubLimits> = {},
): Promise<{ merged: boolean; snapshot: PullRequestSnapshot }> {
	const limits = withDefaults(limitOverrides);
	const deadline = deps.now() + limits.landingMs;
	let latest = await getPullRequest(exec, cwd, number, signal, limits);
	while (latest.state !== "MERGED" && deps.now() < deadline) {
		if (latest.headRef !== expectedRef || latest.headOid !== expectedSha || latest.state === "CLOSED")
			return { merged: false, snapshot: latest };
		await deps.sleep(limits.pollMs, signal);
		latest = await getPullRequest(exec, cwd, number, signal, limits);
	}
	return {
		merged:
			latest.state === "MERGED" &&
			latest.mergedAt !== null &&
			latest.headRef === expectedRef &&
			latest.headOid === expectedSha,
		snapshot: latest,
	};
}
