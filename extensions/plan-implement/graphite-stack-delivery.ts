/** Validated local Graphite stack evidence and parent-owned publication. */

import { createHash } from "node:crypto";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { acquirePublicationLock } from "../shared/publication-lock.ts";

const MAX_SLICES = 50;
const MAX_REF_CHARS = 240;
const MAX_SUBJECT_CHARS = 240;
const SHA_RE = /^[0-9a-f]{40}$/;
const OWNED_BRANCH_RE = /^kstack\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/* exported: Graphite stack-delivery contract */
export interface GraphiteStackSlice {
	branch: string;
	baseBranch: string;
	headSha: string;
	subject: string;
}

/* exported: Graphite stack-delivery contract */
export interface GraphiteStackManifest {
	schemaVersion: 1;
	trunkRef: string;
	trunkSha: string;
	slices: readonly GraphiteStackSlice[];
}

/* exported: Graphite stack-delivery contract */
export type GraphiteManifestParseResult = { ok: true; manifest: GraphiteStackManifest } | { ok: false; error: string };

/* exported: Graphite stack-delivery contract */
export interface VerifiedGraphiteStack {
	repositoryRoot: string;
	manifest: GraphiteStackManifest;
}

/* exported: Graphite stack-delivery contract */
export interface GraphitePublishedPullRequest {
	ref: string;
	baseRef: string;
	headSha: string;
	prNumber: number;
	url: string;
	draft: boolean;
}

interface ExistingPullRequest extends GraphitePublishedPullRequest {
	state: "OPEN";
}

/* exported: Graphite stack-delivery contract */
export interface GraphitePublicationPlan {
	planId: string;
	repositoryRoot: string;
	manifest: GraphiteStackManifest;
	existing: readonly ExistingPullRequest[];
	preview: string;
}

/* exported: Graphite stack-delivery contract */
export type GraphiteStackPublishResult =
	| { status: "completed"; planId: string; pullRequests: readonly GraphitePublishedPullRequest[] }
	| { status: "blocked"; error: string }
	| { status: "busy"; error: string }
	| { status: "stale"; expectedPlanId: string; actualPlanId: string }
	| { status: "partial"; error: string; pullRequests: readonly GraphitePublishedPullRequest[] }
	| { status: "indeterminate"; error: string }
	| { status: "failed"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function safeRef(value: unknown, owned = false): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REF_CHARS) return false;
	if (!(owned ? OWNED_BRANCH_RE : SAFE_REF_RE).test(value)) return false;
	return !value.includes("..") && !value.includes("//") && !value.endsWith(".") && !value.endsWith(".lock");
}

/** Parse bounded evidence. The parent still verifies every field against Git and Graphite. */
export function parseGraphiteStackManifest(raw: string): GraphiteManifestParseResult {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { ok: false, error: "Graphite stack manifest is not valid JSON." };
	}
	if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "trunkRef", "trunkSha", "slices"])) {
		return {
			ok: false,
			error: "Graphite stack manifest must contain only schemaVersion, trunkRef, trunkSha, and slices.",
		};
	}
	if (value.schemaVersion !== 1 || !safeRef(value.trunkRef) || !SHA_RE.test(String(value.trunkSha))) {
		return { ok: false, error: "Graphite stack manifest has an unsupported schema or invalid trunk." };
	}
	if (!Array.isArray(value.slices) || value.slices.length === 0 || value.slices.length > MAX_SLICES) {
		return { ok: false, error: `Graphite stack manifest must contain 1-${MAX_SLICES} slices.` };
	}
	const slices: GraphiteStackSlice[] = [];
	const seen = new Set<string>();
	for (const candidate of value.slices) {
		if (!isRecord(candidate) || !exactKeys(candidate, ["branch", "baseBranch", "headSha", "subject"])) {
			return { ok: false, error: "Every Graphite slice must contain only branch, baseBranch, headSha, and subject." };
		}
		if (
			!safeRef(candidate.branch, true) ||
			!safeRef(candidate.baseBranch) ||
			!SHA_RE.test(String(candidate.headSha)) ||
			typeof candidate.subject !== "string" ||
			candidate.subject.trim().length === 0 ||
			candidate.subject.length > MAX_SUBJECT_CHARS ||
			/[\0\r\n]/.test(candidate.subject) ||
			seen.has(candidate.branch)
		) {
			return { ok: false, error: "Graphite stack manifest has invalid or duplicate slice fields." };
		}
		seen.add(candidate.branch);
		slices.push({
			branch: candidate.branch,
			baseBranch: candidate.baseBranch,
			headSha: String(candidate.headSha),
			subject: candidate.subject,
		});
	}
	if (slices[0].baseBranch !== value.trunkRef) {
		return { ok: false, error: "The first Graphite slice must be based on trunk." };
	}
	for (let index = 1; index < slices.length; index++) {
		if (slices[index].baseBranch !== slices[index - 1].branch) {
			return { ok: false, error: "Graphite stack slices must form a linear base chain." };
		}
	}
	return {
		ok: true,
		manifest: { schemaVersion: 1, trunkRef: value.trunkRef, trunkSha: String(value.trunkSha), slices },
	};
}

function diagnostic(result: ExecFnResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

async function run(
	exec: ExecFn,
	command: string,
	args: string[],
	cwd: string,
	timeout = 15_000,
): Promise<ExecFnResult> {
	try {
		return await exec(command, args, { cwd, timeout });
	} catch (error) {
		return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

/** Recheck manifest evidence against immutable Git facts and a Graphite dry run. */
export async function verifyGraphiteStack(
	cwd: string,
	manifest: GraphiteStackManifest,
	exec: ExecFn,
): Promise<{ ok: true; stack: VerifiedGraphiteStack } | { ok: false; error: string }> {
	const root = await run(exec, "git", ["rev-parse", "--show-toplevel"], cwd);
	const repositoryRoot = root.stdout.trim();
	if (root.code !== 0 || !repositoryRoot)
		return { ok: false, error: `Could not resolve the Git root: ${diagnostic(root)}` };
	const clean = await run(exec, "git", ["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot);
	if (clean.code !== 0 || clean.stdout.trim())
		return { ok: false, error: "Graphite stack publication requires a clean working tree." };
	const current = await run(exec, "git", ["branch", "--show-current"], repositoryRoot);
	const top = manifest.slices.at(-1)!;
	if (current.code !== 0 || current.stdout.trim() !== top.branch) {
		return { ok: false, error: `The manifest top ${top.branch} must be checked out before publication.` };
	}
	const trunk = await run(
		exec,
		"git",
		["rev-parse", "--verify", `refs/heads/${manifest.trunkRef}^{commit}`],
		repositoryRoot,
	);
	if (trunk.code !== 0 || trunk.stdout.trim() !== manifest.trunkSha) {
		return { ok: false, error: `Graphite trunk ${manifest.trunkRef} moved after the stack was planned.` };
	}
	for (const slice of manifest.slices) {
		const format = await run(exec, "git", ["check-ref-format", "--branch", slice.branch], repositoryRoot);
		if (format.code !== 0) return { ok: false, error: `Invalid Graphite branch name: ${slice.branch}.` };
		const head = await run(
			exec,
			"git",
			["rev-parse", "--verify", `refs/heads/${slice.branch}^{commit}`],
			repositoryRoot,
		);
		if (head.code !== 0 || head.stdout.trim() !== slice.headSha) {
			return { ok: false, error: `Graphite branch ${slice.branch} no longer matches manifest head ${slice.headSha}.` };
		}
		const base = await run(
			exec,
			"git",
			["rev-parse", "--verify", `refs/heads/${slice.baseBranch}^{commit}`],
			repositoryRoot,
		);
		if (base.code !== 0 || !SHA_RE.test(base.stdout.trim())) {
			return { ok: false, error: `Graphite base branch ${slice.baseBranch} is missing.` };
		}
		const ancestor = await run(
			exec,
			"git",
			["merge-base", "--is-ancestor", base.stdout.trim(), slice.headSha],
			repositoryRoot,
		);
		if (ancestor.code !== 0) return { ok: false, error: `${slice.branch} is not based on ${slice.baseBranch}.` };
		const diff = await run(exec, "git", ["diff", "--quiet", base.stdout.trim(), slice.headSha, "--"], repositoryRoot);
		if (diff.code === 0) return { ok: false, error: `Graphite slice ${slice.branch} has an empty diff.` };
		if (diff.code !== 1)
			return { ok: false, error: `Could not inspect Graphite slice ${slice.branch}: ${diagnostic(diff)}` };
	}
	const dryRun = await run(
		exec,
		"gt",
		["--no-interactive", "--no-ai", "submit", "--stack", "--draft", "--no-edit", "--dry-run"],
		repositoryRoot,
		60_000,
	);
	if (dryRun.code !== 0) return { ok: false, error: `gt submit --stack --dry-run failed: ${diagnostic(dryRun)}` };
	return { ok: true, stack: { repositoryRoot, manifest } };
}

function parsePullRequests(raw: string, expectedRef: string): ExistingPullRequest[] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const parsed: ExistingPullRequest[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		if (
			!Number.isSafeInteger(item.number) ||
			Number(item.number) <= 0 ||
			typeof item.url !== "string" ||
			item.headRefName !== expectedRef ||
			!safeRef(item.baseRefName) ||
			!SHA_RE.test(String(item.headRefOid)) ||
			typeof item.isDraft !== "boolean"
		)
			return undefined;
		parsed.push({
			state: "OPEN",
			ref: expectedRef,
			baseRef: item.baseRefName,
			headSha: String(item.headRefOid),
			prNumber: Number(item.number),
			url: item.url,
			draft: item.isDraft,
		});
	}
	return parsed;
}

async function existingForRef(
	exec: ExecFn,
	cwd: string,
	ref: string,
): Promise<{ ok: true; pr?: ExistingPullRequest } | { ok: false; error: string }> {
	const result = await run(
		exec,
		"gh",
		["pr", "list", "--state", "open", "--head", ref, "--json", "number,url,headRefName,baseRefName,headRefOid,isDraft"],
		cwd,
	);
	if (result.code !== 0) return { ok: false, error: `Could not inspect GitHub PR for ${ref}: ${diagnostic(result)}` };
	const parsed = parsePullRequests(result.stdout, ref);
	if (!parsed) return { ok: false, error: `GitHub returned invalid PR data for ${ref}.` };
	if (parsed.length > 1)
		return { ok: false, error: `Expected at most one open PR for ${ref}; found ${parsed.length}.` };
	return { ok: true, ...(parsed[0] ? { pr: parsed[0] } : {}) };
}

/** Build the exact plan shown before the one multi-ref submit. */
export async function planGraphitePublication(
	stack: VerifiedGraphiteStack,
	exec: ExecFn,
): Promise<{ ok: true; plan: GraphitePublicationPlan } | { ok: false; error: string }> {
	const existing: ExistingPullRequest[] = [];
	for (const slice of stack.manifest.slices) {
		const found = await existingForRef(exec, stack.repositoryRoot, slice.branch);
		if (!found.ok) return found;
		if (found.pr) existing.push(found.pr);
	}
	const facts = {
		repositoryRoot: stack.repositoryRoot,
		trunkSha: stack.manifest.trunkSha,
		slices: stack.manifest.slices,
		existing: existing.map((pr) => ({
			ref: pr.ref,
			baseRef: pr.baseRef,
			headSha: pr.headSha,
			prNumber: pr.prNumber,
			draft: pr.draft,
		})),
	};
	const planId = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
	const existingByRef = new Map(existing.map((pr) => [pr.ref, pr]));
	const preview = [
		`Graphite stack publication ${planId.slice(0, 16)}`,
		...stack.manifest.slices.map((slice) => {
			const pr = existingByRef.get(slice.branch);
			return `- ${pr ? `update PR #${pr.prNumber}` : "create draft PR"}: ${slice.branch} -> ${slice.baseBranch} @ ${slice.headSha.slice(0, 12)}`;
		}),
		"Graphite may force-with-lease update every listed branch.",
	].join("\n");
	return {
		ok: true,
		plan: { planId, repositoryRoot: stack.repositoryRoot, manifest: stack.manifest, existing, preview },
	};
}

/** Revalidate under a repository lock, submit once, and verify every exact GitHub PR. */
export async function submitGraphiteStack(
	plan: GraphitePublicationPlan,
	exec: ExecFn,
	deps: { acquireLock?: typeof acquirePublicationLock } = {},
): Promise<GraphiteStackPublishResult> {
	const lock = (deps.acquireLock ?? acquirePublicationLock)({ repositoryPath: plan.repositoryRoot });
	if (!lock.ok) return { status: "busy", error: "Another stack publication is active for this repository." };
	try {
		const verified = await verifyGraphiteStack(plan.repositoryRoot, plan.manifest, exec);
		if (!verified.ok) return { status: "blocked", error: verified.error };
		const current = await planGraphitePublication(verified.stack, exec);
		if (!current.ok) return { status: "blocked", error: current.error };
		if (current.plan.planId !== plan.planId) {
			return { status: "stale", expectedPlanId: plan.planId, actualPlanId: current.plan.planId };
		}
		let submitted: ExecFnResult;
		try {
			submitted = await exec("gt", ["--no-interactive", "--no-ai", "submit", "--stack", "--draft", "--no-edit"], {
				cwd: plan.repositoryRoot,
				timeout: 60_000,
			});
		} catch (error) {
			return {
				status: "indeterminate",
				error: `gt submit may have started before the process failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (submitted.code !== 0) return { status: "failed", error: `gt submit --stack failed: ${diagnostic(submitted)}` };

		const pullRequests: GraphitePublishedPullRequest[] = [];
		for (const slice of plan.manifest.slices) {
			const found = await existingForRef(exec, plan.repositoryRoot, slice.branch);
			if (!found.ok || !found.pr) {
				return {
					status: "partial",
					error: found.ok ? `Graphite submitted ${slice.branch}, but its PR is not visible.` : found.error,
					pullRequests,
				};
			}
			const pr = found.pr;
			if (pr.headSha !== slice.headSha || pr.baseRef !== slice.baseBranch || !pr.draft) {
				return {
					status: "partial",
					error: `PR #${pr.prNumber} does not match expected head/base/draft state after Graphite submission.`,
					pullRequests,
				};
			}
			pullRequests.push(pr);
		}
		return { status: "completed", planId: plan.planId, pullRequests };
	} finally {
		lock.lock.release();
	}
}
