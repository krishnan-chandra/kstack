import type { ExecFn, ExecFnResult } from "./git-exec.ts";
import { GitHubError, isGitHubIndeterminate, runGitHubMutation } from "./github-command.ts";
import { asRecord } from "./narrow.ts";
import type { NavigationStatus } from "./stack/topology.ts";
import { type BoundaryValue, isBoolean, isNumber, isObject, isString, type JsonObject } from "./validation.ts";

/** Merge methods Kstack permits anywhere; merge commits are never allowed. */
export type MergeMethod = "squash" | "rebase";

export function isMergeMethod(value: BoundaryValue): value is MergeMethod {
	return value === "squash" || value === "rebase";
}

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

export interface PullRequestReviewTarget {
	number: number;
	url: string;
	title: string;
	state: PullRequestSnapshot["state"];
	baseRef: string;
	headOid: string;
	baseOid: string;
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
const ZERO_OID = "0".repeat(40);
const UPDATE_REFS_MUTATION =
	"mutation($repositoryId:ID!,$name:GitRefname!,$beforeOid:GitObjectID!,$afterOid:GitObjectID!){updateRefs(input:{repositoryId:$repositoryId,refUpdates:[{name:$name,beforeOid:$beforeOid,afterOid:$afterOid}]}){clientMutationId}}";
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
		throw new GitHubError("GitHub CLI returned invalid JSON.");
	}
}

function diagnostic(text: string, maxBytes: number): string {
	return text.slice(0, maxBytes).trim();
}

function withDefaults(limits: Partial<GithubLimits>): GithubLimits {
	return { ...DEFAULT_LIMITS, ...limits };
}

interface PullRequestJson {
	value: JsonObject;
	identity: Pick<PullRequestSnapshot, "number" | "url" | "title" | "state">;
}

async function readPullRequestJson(
	exec: ExecFn,
	cwd: string,
	number: number,
	fields: string,
	signal: AbortSignal | undefined,
	limits: GithubLimits,
	repository?: string,
): Promise<PullRequestJson> {
	const repoArgs = repository === undefined ? [] : ["-R", repository];
	const out = await exec("gh", ["pr", "view", String(number), ...repoArgs, "--json", fields], {
		cwd,
		timeout: limits.queryMs,
		signal,
	});
	if (out.code !== 0)
		throw new GitHubError(`Could not read PR #${number}: ${diagnostic(out.stderr, limits.diagnosticsBytes)}`);
	const value = asRecord(parseJson(out.stdout));
	if (
		value?.number !== number ||
		!isString(value.url) ||
		!value.url.startsWith("https://") ||
		!isString(value.title) ||
		!["OPEN", "CLOSED", "MERGED"].includes(String(value.state))
	)
		throw new GitHubError(`PR #${number} response failed validation.`);
	return {
		value,
		identity: {
			number,
			url: value.url,
			title: value.title,
			state:
				/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ value.state as PullRequestSnapshot["state"],
		},
	};
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
		throw new GitHubError(
			`Could not resolve authenticated GitHub repository: ${diagnostic(out.stderr, limits.diagnosticsBytes)}`,
		);
	const value = asRecord(parseJson(out.stdout));
	const branch = asRecord(value?.defaultBranchRef);
	if (!isString(value?.nameWithOwner) || !isString(branch?.name))
		throw new GitHubError("GitHub repository response is missing identity/default branch.");
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
	const { value, identity } = await readPullRequestJson(
		exec,
		cwd,
		number,
		"number,url,title,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,mergedAt,mergeCommit",
		signal,
		limits,
	);
	const commit = asRecord(value.mergeCommit);
	if (
		!isBoolean(value.isDraft) ||
		!isString(value.headRefName) ||
		!isString(value.baseRefName) ||
		!isString(value.headRefOid) ||
		!SHA.test(value.headRefOid)
	)
		throw new GitHubError(`PR #${number} response failed validation.`);
	return {
		...identity,
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

export async function getPullRequestReviewTarget(
	exec: ExecFn,
	cwd: string,
	number: number,
	signal?: AbortSignal,
	limitOverrides: Partial<GithubLimits> = {},
	/** `owner/name` for `gh -R`; required when `cwd` has no Git remotes (jj workspaces). */
	repository?: string,
): Promise<PullRequestReviewTarget> {
	const limits = withDefaults(limitOverrides);
	const { value, identity } = await readPullRequestJson(
		exec,
		cwd,
		number,
		"number,url,title,state,baseRefName,headRefOid,baseRefOid",
		signal,
		limits,
		repository,
	);
	if (
		!isString(value.baseRefName) ||
		!isString(value.headRefOid) ||
		!SHA.test(value.headRefOid) ||
		!isString(value.baseRefOid) ||
		!SHA.test(value.baseRefOid)
	)
		throw new GitHubError(`PR #${number} response failed validation.`);
	return {
		...identity,
		baseRef: value.baseRefName,
		headOid: value.headRefOid,
		baseOid: value.baseRefOid,
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
		throw new GitHubError(
			`Could not resolve an open PR for branch ${headRef}: ${diagnostic(out.stderr, limits.diagnosticsBytes)}`,
		);
	const value = parseJson(out.stdout);
	if (!Array.isArray(value)) throw new GitHubError("GitHub PR list response failed validation.");
	const matches = value.filter((entry) => {
		const candidate = asRecord(entry);
		return candidate?.headRefName === headRef && Number.isSafeInteger(candidate.number) && Number(candidate.number) > 0;
	});
	if (matches.length !== 1)
		throw new GitHubError(`Expected exactly one open PR with head ${headRef}; found ${matches.length}.`);
	const match = asRecord(matches[0]);
	if (!match || !isNumber(match.number)) throw new GitHubError("GitHub PR list response failed validation.");
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
	if (signal?.aborted) {
		throw new GitHubError(`Merge request for PR #${number} was aborted before dispatch.`);
	}
	const limits = withDefaults(limitOverrides);
	let out: ExecFnResult;
	try {
		out = await exec("gh", ["pr", "merge", String(number), `--${method}`, "--match-head-commit", sha], {
			cwd,
			timeout: limits.mergeMs,
			signal,
		});
	} catch (error) {
		if (error instanceof GitHubError && error.kind === "indeterminate") throw error;
		throw new GitHubError(
			`GitHub merge request for PR #${number} ended without a conclusive result: ${error instanceof Error ? error.message : String(error)}`,
			"indeterminate",
		);
	}
	if (out.killed) {
		throw new GitHubError(
			`GitHub merge request for PR #${number} was killed before a conclusive result: ${diagnostic(out.stderr || out.stdout, limits.diagnosticsBytes)}`,
			"indeterminate",
		);
	}
	if (out.code !== 0)
		throw new GitHubError(
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

export interface GitHubRepository {
	owner: string;
	repo: string;
}
export interface OpenPullRequest {
	number: number;
	headRef: string;
	headCommitId: string;
	baseRef: string;
	title: string;
	draft: boolean;
	url: string;
	headOwner: string;
}
export interface GitHubComment {
	id: number;
	body: string;
	user: string | undefined;
}
const GITHUB_URL_PATTERN =
	/^(?:https:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:|ssh:\/\/(?:[^@]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/;

export function parseGithubUrl(url: string): GitHubRepository | undefined {
	const match = GITHUB_URL_PATTERN.exec(url.trim());
	if (!match) return undefined;
	return { owner: match[1], repo: match[2] };
}

export function redactUrl(url: string): string {
	return url.replace(/(https?:\/\/)[^@]+@/g, "$1***@");
}

interface MergedPrInfo {
	merged: boolean;
	mergeCommitOid: string | undefined;
	headCommitId: string;
	headRef: string;
}

export type DeleteRemoteBranchResult =
	| { kind: "deleted" }
	| { kind: "already-gone" }
	| { kind: "changed"; actualHeadSha: string };

export interface GitHubGateway {
	getDefaultBranch(repo: GitHubRepository, cwd: string, signal?: AbortSignal): Promise<string>;
	listOpenPrs(repo: GitHubRepository, cwd: string, signal?: AbortSignal): Promise<OpenPullRequest[]>;
	listPrsForHead(repo: GitHubRepository, head: string, cwd: string, signal?: AbortSignal): Promise<OpenPullRequest[]>;
	getAuthenticatedUser(cwd: string, signal?: AbortSignal): Promise<string | undefined>;
	getPrStatus(repo: GitHubRepository, prNumber: number, cwd: string, signal?: AbortSignal): Promise<NavigationStatus>;
	getPrComments(repo: GitHubRepository, prNumber: number, cwd: string, signal?: AbortSignal): Promise<GitHubComment[]>;
	getMergeCommit(repo: GitHubRepository, prNumber: number, cwd: string, signal?: AbortSignal): Promise<MergedPrInfo>;
	getAllowedMergeMethods(repo: GitHubRepository, cwd: string, signal?: AbortSignal): Promise<MergeMethod[]>;
	getRemoteBranchSha(
		repo: GitHubRepository,
		branch: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<string | undefined>;
	markPrReady(repo: GitHubRepository, prNumber: number, cwd: string, signal?: AbortSignal): Promise<void>;
	deleteRemoteBranch(input: {
		repo: GitHubRepository;
		branch: string;
		expectedHeadSha: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<DeleteRemoteBranchResult>;
	createDraftPr(input: {
		repo: GitHubRepository;
		ref: string;
		base: string;
		title: string;
		body: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<OpenPullRequest>;
	updatePrBase(input: {
		repo: GitHubRepository;
		prNumber: number;
		base: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<void>;
	createOrUpdateComment(input: {
		repo: GitHubRepository;
		prNumber: number;
		body: string;
		existingCommentId?: number;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<{ id: number }>;
}

export { GitHubError, isGitHubIndeterminate };

export function createGitHubGateway(run: ExecFn): GitHubGateway {
	async function readBranchSha(
		repo: GitHubRepository,
		branch: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		assertRefName(branch);
		try {
			const result = await runGitHubMutation(
				run,
				["api", `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"],
				{ cwd, signal },
			);
			const sha = result.stdout.trim();
			if (!sha) throw new GitHubError(`Could not read remote branch ${JSON.stringify(branch)}.`);
			return sha;
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
	}

	return {
		async getDefaultBranch(repo, cwd, signal) {
			const result = await runGitHubMutation(
				run,
				["api", `/repos/${repo.owner}/${repo.repo}`, "--jq", ".default_branch"],
				{
					cwd,
					signal,
				},
			);
			const branch = result.stdout.trim();
			if (!branch) throw new GitHubError(`Could not read default branch for ${repo.owner}/${repo.repo}.`);
			return branch;
		},
		async listOpenPrs(repo, cwd, signal) {
			return listPulls(run, repo, cwd, "open", signal);
		},
		async listPrsForHead(repo, head, cwd, signal) {
			const prs = await listPulls(run, repo, cwd, "all", signal, head);
			return prs.filter((pr) => pr.headRef === head);
		},
		async getAuthenticatedUser(cwd, signal) {
			try {
				const result = await runGitHubMutation(run, ["api", "user", "--jq", ".login"], { cwd, signal });
				return result.stdout.trim() || undefined;
			} catch {
				return undefined;
			}
		},
		async getPrStatus(repo, prNumber, cwd, signal) {
			const result = await runGitHubMutation(
				run,
				["api", `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`, "--jq", "{state, merged, draft}"],
				{ cwd, signal },
			);
			return parsePrStatus(result.stdout, prNumber);
		},
		async getPrComments(repo, prNumber, cwd, signal) {
			const result = await runGitHubMutation(
				run,
				[
					"api",
					`/repos/${repo.owner}/${repo.repo}/issues/${prNumber}/comments`,
					"--jq",
					".[] | {id, body, user: .user.login}",
					"--paginate",
				],
				{ cwd, signal },
			);
			return parseComments(result.stdout, prNumber);
		},
		async getAllowedMergeMethods(repo, cwd, signal) {
			const result = await runGitHubMutation(
				run,
				[
					"api",
					`/repos/${repo.owner}/${repo.repo}`,
					"--jq",
					"{squash: .allow_squash_merge, rebase: .allow_rebase_merge}",
				],
				{ cwd, signal },
			);
			return parseAllowedMergeMethods(result.stdout, repo);
		},
		async getMergeCommit(repo, prNumber, cwd, signal) {
			const result = await runGitHubMutation(
				run,
				[
					"api",
					`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`,
					"--jq",
					"{merged, mergeCommitOid: .merge_commit_sha, headCommitId: .head.sha, headRef: .head.ref}",
				],
				{ cwd, signal },
			);
			return parseMergeCommit(result.stdout, prNumber);
		},
		getRemoteBranchSha(repo, branch, cwd, signal) {
			return readBranchSha(repo, branch, cwd, signal);
		},
		async markPrReady(repo, prNumber, cwd, signal) {
			await runGitHubMutation(run, ["pr", "ready", String(prNumber), "--repo", `${repo.owner}/${repo.repo}`], {
				cwd,
				signal,
			});
		},
		async deleteRemoteBranch(input) {
			const branch = input.branch.startsWith("refs/heads/") ? input.branch.slice("refs/heads/".length) : input.branch;
			assertRefName(branch);
			if (!SHA.test(input.expectedHeadSha)) {
				throw new GitHubError(`Invalid expected head SHA: ${JSON.stringify(input.expectedHeadSha)}.`);
			}
			const preSha = await readBranchSha(input.repo, branch, input.cwd, input.signal);
			if (preSha === undefined) return { kind: "already-gone" };
			if (preSha !== input.expectedHeadSha) return { kind: "changed", actualHeadSha: preSha };

			const repoResult = await runGitHubMutation(
				run,
				["api", `/repos/${input.repo.owner}/${input.repo.repo}`, "--jq", ".node_id"],
				{ cwd: input.cwd, signal: input.signal },
			);
			const repositoryId = repoResult.stdout.trim();
			if (!repositoryId) {
				throw new GitHubError(`Could not resolve repository ID for ${input.repo.owner}/${input.repo.repo}.`);
			}

			async function classifyRejection(cause: Error): Promise<DeleteRemoteBranchResult> {
				let postSha: string | undefined;
				try {
					postSha = await readBranchSha(input.repo, branch, input.cwd, input.signal);
				} catch {
					throw cause;
				}
				if (postSha === undefined) return { kind: "already-gone" };
				if (postSha !== input.expectedHeadSha) return { kind: "changed", actualHeadSha: postSha };
				throw cause;
			}

			let mutationResult: { stdout: string };
			try {
				mutationResult = await runGitHubMutation(
					run,
					[
						"api",
						"graphql",
						"-f",
						`query=${UPDATE_REFS_MUTATION}`,
						"-f",
						`repositoryId=${repositoryId}`,
						"-f",
						`name=refs/heads/${branch}`,
						"-f",
						`beforeOid=${input.expectedHeadSha}`,
						"-f",
						`afterOid=${ZERO_OID}`,
					],
					{ cwd: input.cwd, signal: input.signal },
				);
			} catch (error) {
				if (error instanceof GitHubError && error.kind === "indeterminate") {
					throw error;
				}
				return classifyRejection(error instanceof Error ? error : new Error(String(error)));
			}

			let parsed: BoundaryValue;
			try {
				parsed = parseJson(mutationResult.stdout);
			} catch {
				throw new GitHubError("GitHub returned invalid JSON for updateRefs mutation.");
			}
			const record = asRecord(parsed);
			if (Array.isArray(record?.errors) && record.errors.length > 0) {
				const first = asRecord(record.errors[0]);
				const message = isString(first?.message) ? first.message : "GraphQL updateRefs failed";
				return classifyRejection(new GitHubError(message));
			}
			if (asRecord(record?.data)?.updateRefs == null) {
				throw new GitHubError("GitHub returned an invalid updateRefs success envelope.");
			}
			return { kind: "deleted" };
		},
		async createDraftPr(input) {
			const created = await runGitHubMutation(
				run,
				[
					"pr",
					"create",
					"--repo",
					`${input.repo.owner}/${input.repo.repo}`,
					"--head",
					input.ref,
					"--base",
					input.base,
					"--title",
					input.title,
					"--body",
					input.body,
					"--draft",
				],
				{ cwd: input.cwd, signal: input.signal },
			);
			const prUrl = created.stdout.trim();
			try {
				const viewed = await runGitHubMutation(
					run,
					["pr", "view", prUrl, "--json", "number,headRefName,headRefOid,baseRefName,title,isDraft,url"],
					{ cwd: input.cwd, signal: input.signal },
				);
				const info = parseCreatedPr(viewed.stdout, prUrl, input.repo);
				if (info) return info;
			} catch {
				/* fall through to the unresolved-create error */
			}
			throw new GitHubError(
				`Created PR for ref ${JSON.stringify(input.ref)} at ${JSON.stringify(prUrl)}, but could not read its metadata. Run plan again to continue safely.`,
				"indeterminate",
			);
		},
		async updatePrBase(input) {
			await runGitHubMutation(
				run,
				[
					"api",
					`/repos/${input.repo.owner}/${input.repo.repo}/pulls/${input.prNumber}`,
					"--method",
					"PATCH",
					"--field",
					`base=${input.base}`,
				],
				{ cwd: input.cwd, signal: input.signal },
			);
		},
		async createOrUpdateComment(input) {
			const args =
				input.existingCommentId !== undefined
					? [
							"api",
							`/repos/${input.repo.owner}/${input.repo.repo}/issues/comments/${input.existingCommentId}`,
							"--method",
							"PATCH",
							"--field",
							`body=${input.body}`,
						]
					: [
							"api",
							`/repos/${input.repo.owner}/${input.repo.repo}/issues/${input.prNumber}/comments`,
							"--method",
							"POST",
							"--field",
							`body=${input.body}`,
						];
			const result = await runGitHubMutation(run, args, { cwd: input.cwd, signal: input.signal });
			try {
				const parsed: BoundaryValue = JSON.parse(result.stdout);
				if (isObject(parsed) && parsed !== null && "id" in parsed && Number.isSafeInteger(parsed.id)) {
					return { id: Number(parsed.id) };
				}
			} catch {
				/* keep a synthetic id only for an in-place update */
			}
			if (input.existingCommentId !== undefined) return { id: input.existingCommentId };
			throw new GitHubError(
				`Created comment on PR #${input.prNumber}, but could not read its id. Inspect the PR before retrying.`,
				"indeterminate",
			);
		},
	};
}

export function parseOpenPrs(text: string, repo: GitHubRepository): OpenPullRequest[] {
	const items = decodeJsonSequence(text);
	const expected = `${repo.owner}/${repo.repo}`.toLowerCase();
	const prs: OpenPullRequest[] = [];
	for (const item of items) {
		if (!isObject(item) || item === null) continue;
		const record =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ item as JsonObject;
		const headRepository = record.headRepository;
		const headRepositoryOwner = record.headRepositoryOwner;
		if (headRepository === null || headRepository === undefined) continue;
		if (!isObject(headRepository)) continue;
		const nameWithOwner =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
				headRepository as JsonObject
			).nameWithOwner;
		if (!isString(nameWithOwner) || nameWithOwner.toLowerCase() !== expected) continue;
		const ownerLogin =
			isObject(headRepositoryOwner) && headRepositoryOwner !== null
				? /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
						headRepositoryOwner as JsonObject
					).login
				: "";
		if (
			!Number.isSafeInteger(record.number) ||
			Number(record.number) <= 0 ||
			!isString(record.headRefName) ||
			!isString(record.headCommitId) ||
			!isString(record.baseRefName)
		) {
			continue;
		}
		prs.push({
			number: Number(record.number),
			headRef: record.headRefName,
			headCommitId: record.headCommitId,
			baseRef: record.baseRefName,
			title: isString(record.title) ? record.title : "",
			draft: Boolean(record.isDraft),
			url: isString(record.url) ? record.url : "",
			headOwner: isString(ownerLogin) ? ownerLogin : "",
		});
	}
	return prs;
}

export function parseAllowedMergeMethods(text: string, repo: GitHubRepository): MergeMethod[] {
	let payload: BoundaryValue;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new GitHubError(`Could not parse merge methods for ${repo.owner}/${repo.repo}: invalid JSON.`);
	}
	if (!isObject(payload) || payload === null) {
		throw new GitHubError(`Could not parse merge methods for ${repo.owner}/${repo.repo}: invalid response.`);
	}
	const record =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ payload as JsonObject;
	const methods: MergeMethod[] = [];
	if (record.squash === true) methods.push("squash");
	if (record.rebase === true) methods.push("rebase");
	return methods;
}

export function parseMergeCommit(text: string, prNumber: number): MergedPrInfo {
	let payload: BoundaryValue;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new GitHubError(`Could not parse merge commit for PR #${prNumber}: invalid JSON.`);
	}
	if (!isObject(payload) || payload === null) {
		throw new GitHubError(`Could not parse merge commit for PR #${prNumber}: invalid response.`);
	}
	const record =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ payload as JsonObject;
	if (!isBoolean(record.merged) || !isString(record.headCommitId) || !isString(record.headRef)) {
		throw new GitHubError(`Could not parse merge commit for PR #${prNumber}: invalid response.`);
	}
	const oid = record.mergeCommitOid;
	if (oid !== null && oid !== undefined && !isString(oid)) {
		throw new GitHubError(`Could not parse merge commit for PR #${prNumber}: invalid merge commit.`);
	}
	return {
		merged: record.merged,
		mergeCommitOid: isString(oid) && oid.length > 0 ? oid : undefined,
		headCommitId: record.headCommitId,
		headRef: record.headRef,
	};
}

export function parsePrStatus(text: string, prNumber: number): NavigationStatus {
	let payload: BoundaryValue;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new GitHubError(`Could not parse status for PR #${prNumber}: invalid JSON.`);
	}
	const record = asRecord(payload);
	if (!record || !isBoolean(record.merged) || (record.state !== "open" && record.state !== "closed")) {
		throw new GitHubError(`Could not parse status for PR #${prNumber}: invalid response.`);
	}
	if (record.merged) return "merged";
	if (record.draft) return "draft";
	return record.state;
}

async function listPulls(
	run: ExecFn,
	repo: GitHubRepository,
	cwd: string,
	state: "open" | "all",
	signal?: AbortSignal,
	headRef?: string,
): Promise<OpenPullRequest[]> {
	const headArgs = headRef === undefined ? [] : ["--raw-field", `head=${repo.owner}:${headRef}`];
	const result = await runGitHubMutation(
		run,
		[
			"api",
			"--method",
			"GET",
			`/repos/${repo.owner}/${repo.repo}/pulls`,
			"--field",
			`state=${state}`,
			"--field",
			"per_page=100",
			...headArgs,
			"--paginate",
			"--jq",
			".[] | {number, headRefName: .head.ref, headCommitId: .head.sha, baseRefName: .base.ref, title, isDraft: .draft, url: .html_url, headRepository: {nameWithOwner: .head.repo.full_name}, headRepositoryOwner: {login: .head.repo.owner.login}}",
		],
		{ cwd, signal },
	);
	return parseOpenPrs(result.stdout, repo);
}

function parseComments(text: string, prNumber: number): GitHubComment[] {
	const comments: GitHubComment[] = [];
	for (const item of decodeJsonSequence(text)) {
		if (!isObject(item) || item === null) {
			throw new GitHubError(`Could not parse comments for PR #${prNumber}: expected JSON objects.`);
		}
		const record =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ item as JsonObject;
		if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0) continue;
		comments.push({
			id: Number(record.id),
			body: isString(record.body) ? record.body : "",
			user: isString(record.user) ? record.user : undefined,
		});
	}
	return comments;
}

function parseCreatedPr(text: string, fallbackUrl: string, repo: GitHubRepository): OpenPullRequest | undefined {
	try {
		const info: BoundaryValue = JSON.parse(text);
		if (!isObject(info) || info === null) return undefined;
		const record =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ info as JsonObject;
		if (!Number.isSafeInteger(record.number) || Number(record.number) <= 0) return undefined;
		if (!isString(record.headRefName) || !isString(record.headRefOid) || !isString(record.baseRefName))
			return undefined;
		return {
			number: Number(record.number),
			headRef: record.headRefName,
			headCommitId: record.headRefOid,
			baseRef: record.baseRefName,
			title: isString(record.title) ? record.title : "",
			draft: Boolean(record.isDraft),
			url: isString(record.url) ? record.url : fallbackUrl,
			headOwner: repo.owner,
		};
	} catch {
		return undefined;
	}
}

function decodeJsonSequence(text: string): BoundaryValue[] {
	const items: BoundaryValue[] = [];
	const trimmed = text.trim();
	if (!trimmed) return items;
	let offset = 0;
	while (offset < trimmed.length) {
		while (offset < trimmed.length && /\s/.test(trimmed[offset])) offset++;
		if (offset >= trimmed.length) break;
		const end = jsonValueEnd(trimmed, offset);
		if (end === undefined) throw new GitHubError("Could not parse GitHub JSON sequence.");
		const parsed: BoundaryValue = JSON.parse(trimmed.slice(offset, end));
		if (Array.isArray(parsed)) items.push(...parsed);
		else items.push(parsed);
		offset = end;
	}
	return items;
}

function jsonValueEnd(text: string, start: number): number | undefined {
	const opener = text[start];
	if (opener !== "{" && opener !== "[") return undefined;
	const closer = opener === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === opener || (opener === "{" && ch === "[") || (opener === "[" && ch === "{")) {
			if (ch === opener) depth++;
			else {
				const nested = jsonValueEnd(text, i);
				if (nested === undefined) return undefined;
				i = nested - 1;
			}
		} else if (ch === closer) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return undefined;
}

function isNotFound(error: BoundaryValue): boolean {
	if (!(error instanceof GitHubError)) return false;
	return /\b404\b|not found/i.test(error.message);
}

function assertRefName(value: string): void {
	if (!value || value.length > 256 || /[\0\n\r\s]/.test(value)) {
		throw new GitHubError(`Invalid branch name: ${JSON.stringify(value)}.`);
	}
}
