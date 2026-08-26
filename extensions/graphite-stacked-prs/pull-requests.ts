import { commandDiagnostic, type ExecFn, runCommand } from "../shared/git-exec.ts";
import { asRecord } from "../shared/narrow.ts";
import { isSafeStackRef, STACK_SHA_RE } from "../shared/stack/manifest.ts";
import { type BoundaryValue, isBoolean, isString } from "../shared/validation.ts";

export const MAX_OPEN_PRS = 50;

/* exported: Graphite open-PR query contract */
export interface GraphiteOpenPullRequest {
	number: number;
	url: string;
	ref: string;
	baseRef: string;
	headSha: string;
	draft: boolean;
}

/* exported: Graphite open-PR query contract */
export type OpenPullRequestFilter = ["--head" | "--base", string];

type OpenPullRequestQueryResult = { ok: true; pullRequests: GraphiteOpenPullRequest[] } | { ok: false; error: string };

function decodeOpenPullRequests(raw: string): GraphiteOpenPullRequest[] | undefined {
	let value: BoundaryValue;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > MAX_OPEN_PRS) return undefined;
	const pullRequests: GraphiteOpenPullRequest[] = [];
	for (const candidate of value) {
		const item = asRecord(candidate);
		if (
			!item ||
			!Number.isSafeInteger(item.number) ||
			Number(item.number) <= 0 ||
			!isString(item.url) ||
			!isSafeStackRef(item.headRefName) ||
			!isSafeStackRef(item.baseRefName) ||
			!STACK_SHA_RE.test(String(item.headRefOid)) ||
			!isBoolean(item.isDraft)
		)
			return undefined;
		pullRequests.push({
			number: Number(item.number),
			url: item.url,
			ref: item.headRefName,
			baseRef: item.baseRefName,
			headSha: String(item.headRefOid),
			draft: item.isDraft,
		});
	}
	return pullRequests;
}

export async function queryOpenPullRequests(input: {
	exec: ExecFn;
	cwd: string;
	filter: OpenPullRequestFilter;
	limit: number;
	signal?: AbortSignal;
}): Promise<OpenPullRequestQueryResult> {
	const limit = Math.min(input.limit, MAX_OPEN_PRS);
	const result = await runCommand(
		input.exec,
		"gh",
		[
			"pr",
			"list",
			"--state",
			"open",
			...input.filter,
			"--limit",
			String(limit),
			"--json",
			"number,url,headRefName,baseRefName,headRefOid,isDraft",
		],
		input.cwd,
		input.signal,
	);
	if (result.code !== 0) {
		return { ok: false, error: `Could not inspect open GitHub PRs: ${commandDiagnostic(result)}` };
	}
	const pullRequests = decodeOpenPullRequests(result.stdout);
	if (!pullRequests) return { ok: false, error: "GitHub returned invalid PR data." };
	return { ok: true, pullRequests };
}
