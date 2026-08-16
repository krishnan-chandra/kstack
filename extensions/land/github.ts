import { asRecord } from "../shared/narrow.ts";
import { type ExecFn, LIMITS, type MergeMethod } from "./types.ts";

interface RepositorySnapshot {
	nameWithOwner: string;
	defaultBranch: string;
	allowedMethods: MergeMethod[];
}
interface PullRequestSnapshot {
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
const SHA = /^[0-9a-f]{40}$/i;
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("GitHub CLI returned invalid JSON.");
	}
}
function diagnostic(text: string): string {
	return text.slice(0, LIMITS.diagnosticsBytes).trim();
}
export async function getRepository(exec: ExecFn, cwd: string, signal?: AbortSignal): Promise<RepositorySnapshot> {
	const out = await exec(
		"gh",
		["repo", "view", "--json", "nameWithOwner,defaultBranchRef,squashMergeAllowed,rebaseMergeAllowed"],
		{ cwd, timeout: LIMITS.queryMs, signal },
	);
	if (out.code !== 0) throw new Error(`Could not resolve authenticated GitHub repository: ${diagnostic(out.stderr)}`);
	const v = asRecord(parseJson(out.stdout));
	const branch = asRecord(v?.defaultBranchRef);
	if (typeof v?.nameWithOwner !== "string" || typeof branch?.name !== "string")
		throw new Error("GitHub repository response is missing identity/default branch.");
	const allowedMethods: MergeMethod[] = [];
	// Kstack policy: merge commits are never allowed
	if (v.squashMergeAllowed === true) allowedMethods.push("squash");
	if (v.rebaseMergeAllowed === true) allowedMethods.push("rebase");
	return { nameWithOwner: v.nameWithOwner, defaultBranch: branch.name, allowedMethods };
}
export async function getPullRequest(
	exec: ExecFn,
	cwd: string,
	number: number,
	signal?: AbortSignal,
): Promise<PullRequestSnapshot> {
	const out = await exec(
		"gh",
		[
			"pr",
			"view",
			String(number),
			"--json",
			"number,url,title,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,mergedAt,mergeCommit",
		],
		{ cwd, timeout: LIMITS.queryMs, signal },
	);
	if (out.code !== 0) throw new Error(`Could not read PR #${number}: ${diagnostic(out.stderr)}`);
	const v = asRecord(parseJson(out.stdout));
	const commit = asRecord(v?.mergeCommit);
	if (
		v?.number !== number ||
		typeof v.url !== "string" ||
		typeof v.title !== "string" ||
		!["OPEN", "CLOSED", "MERGED"].includes(String(v.state)) ||
		typeof v.isDraft !== "boolean" ||
		typeof v.headRefName !== "string" ||
		typeof v.baseRefName !== "string" ||
		typeof v.headRefOid !== "string" ||
		!SHA.test(v.headRefOid)
	)
		throw new Error(`PR #${number} response failed validation.`);
	return {
		number,
		url: v.url,
		title: v.title,
		state: v.state as PullRequestSnapshot["state"],
		isDraft: v.isDraft,
		headRef: v.headRefName,
		baseRef: v.baseRefName,
		headOid: v.headRefOid,
		mergeable: String(v.mergeable),
		mergeStateStatus: String(v.mergeStateStatus),
		mergedAt: typeof v.mergedAt === "string" ? v.mergedAt : null,
		mergeCommitOid: typeof commit?.oid === "string" ? commit.oid : null,
	};
}
export async function findOpenPullRequestByHead(
	exec: ExecFn,
	cwd: string,
	headRef: string,
	signal?: AbortSignal,
): Promise<number> {
	const out = await exec("gh", ["pr", "list", "--state", "open", "--head", headRef, "--json", "number,headRefName"], {
		cwd,
		timeout: LIMITS.queryMs,
		signal,
	});
	if (out.code !== 0) throw new Error(`Could not resolve an open PR for branch ${headRef}: ${diagnostic(out.stderr)}`);
	const value = parseJson(out.stdout);
	if (!Array.isArray(value)) throw new Error("GitHub PR list response failed validation.");
	const matches = value.filter((entry) => {
		const candidate = asRecord(entry);
		return candidate?.headRefName === headRef && Number.isSafeInteger(candidate.number) && Number(candidate.number) > 0;
	});
	if (matches.length !== 1)
		throw new Error(`Expected exactly one open PR with head ${headRef}; found ${matches.length}.`);
	const match = asRecord(matches[0]);
	if (!match || typeof match.number !== "number") throw new Error("GitHub PR list response failed validation.");
	return match.number;
}

export async function mergePullRequest(
	exec: ExecFn,
	cwd: string,
	number: number,
	method: MergeMethod,
	sha: string,
	signal?: AbortSignal,
): Promise<void> {
	const out = await exec("gh", ["pr", "merge", String(number), `--${method}`, "--match-head-commit", sha], {
		cwd,
		timeout: LIMITS.mergeMs,
		signal,
	});
	if (out.code !== 0)
		throw new Error(`GitHub rejected merge for PR #${number}: ${diagnostic(out.stderr || out.stdout)}`);
}
export async function waitForMerge(
	exec: ExecFn,
	cwd: string,
	number: number,
	expectedRef: string,
	expectedSha: string,
	deps: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> },
	signal: AbortSignal,
): Promise<{ merged: boolean; snapshot: PullRequestSnapshot }> {
	const deadline = deps.now() + LIMITS.landingMs;
	let latest = await getPullRequest(exec, cwd, number, signal);
	while (latest.state !== "MERGED" && deps.now() < deadline) {
		if (latest.headRef !== expectedRef || latest.headOid !== expectedSha || latest.state === "CLOSED")
			return { merged: false, snapshot: latest };
		await deps.sleep(LIMITS.pollMs, signal);
		latest = await getPullRequest(exec, cwd, number, signal);
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
