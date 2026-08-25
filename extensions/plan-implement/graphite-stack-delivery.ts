import { type BoundaryValue, isBoolean, isObject, isString, type JsonObject } from "../shared/validation.ts";
/** Validated local Graphite stack evidence and parent-owned publication. */

import { createHash } from "node:crypto";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { type acquirePublicationLock, acquireRepositoryPublicationLock } from "../shared/publication-lock.ts";
import type { StackPublicationMap, StackPublishOutcome } from "../shared/stack/outcome.ts";
import { verifyGraphiteDryRunAffectedRefs } from "../shared/vcs/graphite-dry-run.ts";

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

function graphitePublication(pullRequests: readonly GraphitePublishedPullRequest[]): StackPublicationMap {
	return {
		topRef: pullRequests.at(-1)?.ref ?? "",
		pullRequests,
	};
}

function blockedPublish(message: string): StackPublishOutcome {
	return { status: "blocked", blockers: [{ code: "graphite-publish", message }] };
}

function graphiteSubmitFailure(
	planId: string,
	message: string,
	pullRequests: readonly GraphitePublishedPullRequest[],
): StackPublishOutcome {
	const error = message.trim();
	if (pullRequests.length > 0) {
		return {
			status: "partial",
			planId,
			completedActions: [],
			failedAction: { kind: "create-draft-pr", error },
			publication: graphitePublication(pullRequests),
		};
	}
	return {
		status: "indeterminate",
		planId,
		inFlight: { kind: "create-draft-pr", error },
		completedActions: [],
	};
}

function isRecord(value: BoundaryValue): value is JsonObject {
	return isObject(value) && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function safeRef(value: BoundaryValue, owned = false): value is string {
	if (!isString(value) || value.length === 0 || value.length > MAX_REF_CHARS) return false;
	if (!(owned ? OWNED_BRANCH_RE : SAFE_REF_RE).test(value)) return false;
	return !value.includes("..") && !value.includes("//") && !value.endsWith(".") && !value.endsWith(".lock");
}

/** Parse bounded evidence. The parent still verifies every field against Git and Graphite. */
export function parseGraphiteStackManifest(raw: string): GraphiteManifestParseResult {
	let value: BoundaryValue;
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
			!isString(candidate.subject) ||
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
	const scope = verifyGraphiteDryRunAffectedRefs(
		`${dryRun.stdout}\n${dryRun.stderr}`,
		"submit",
		manifest.slices.map((slice) => slice.branch),
	);
	if (!scope.ok) return { ok: false, error: `Refusing Graphite stack publication: ${scope.error}` };
	return { ok: true, stack: { repositoryRoot, manifest } };
}

function parsePullRequests(raw: string, expectedRef: string): ExistingPullRequest[] | undefined {
	let value: BoundaryValue;
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
			!isString(item.url) ||
			item.headRefName !== expectedRef ||
			!safeRef(item.baseRefName) ||
			!SHA_RE.test(String(item.headRefOid)) ||
			!isBoolean(item.isDraft)
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
	return { ok: true, ...(parsed[0] ? { pr: parsed[0] } : undefined) };
}

async function inspectPublishedStack(
	exec: ExecFn,
	plan: GraphitePublicationPlan,
): Promise<{ pullRequests: GraphitePublishedPullRequest[]; errors: string[] }> {
	const pullRequests: GraphitePublishedPullRequest[] = [];
	const errors: string[] = [];
	for (const slice of plan.manifest.slices) {
		const found = await existingForRef(exec, plan.repositoryRoot, slice.branch);
		if (!found.ok || !found.pr) {
			errors.push(found.ok ? `Graphite submitted ${slice.branch}, but its PR is not visible.` : found.error);
			continue;
		}
		const pr = found.pr;
		if (pr.headSha !== slice.headSha || pr.baseRef !== slice.baseBranch || !pr.draft) {
			errors.push(`PR #${pr.prNumber} does not match expected head/base/draft state after Graphite submission.`);
			continue;
		}
		pullRequests.push(pr);
	}
	return { pullRequests, errors };
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
	deps: { acquireLock?: typeof acquirePublicationLock; realpath?: (path: string) => string } = {},
): Promise<StackPublishOutcome> {
	const lock = await acquireRepositoryPublicationLock(exec, plan.repositoryRoot, deps);
	if (!lock.ok) {
		return lock.kind === "busy"
			? { status: "busy", message: "Another Graphite publication or landing is active for this repository." }
			: { status: "failed", error: lock.error };
	}
	try {
		const verified = await verifyGraphiteStack(plan.repositoryRoot, plan.manifest, exec);
		if (!verified.ok) return blockedPublish(verified.error);
		const current = await planGraphitePublication(verified.stack, exec);
		if (!current.ok) return blockedPublish(current.error);
		if (current.plan.planId !== plan.planId) {
			return { status: "stale", providedPlanId: plan.planId, recomputedPlanId: current.plan.planId };
		}
		let submitted: ExecFnResult;
		try {
			submitted = await exec("gt", ["--no-interactive", "--no-ai", "submit", "--stack", "--draft", "--no-edit"], {
				cwd: plan.repositoryRoot,
				timeout: 60_000,
			});
		} catch (error) {
			const inspected = await inspectPublishedStack(exec, plan);
			const message = `gt submit may have started before the process failed: ${error instanceof Error ? error.message : String(error)} ${inspected.errors.join(" ")}`;
			return graphiteSubmitFailure(plan.planId, message, inspected.pullRequests);
		}
		const inspected = await inspectPublishedStack(exec, plan);
		if (submitted.code !== 0) {
			const message = `gt submit --stack returned ${diagnostic(submitted)} after publication began. ${inspected.errors.join(" ")}`;
			return graphiteSubmitFailure(plan.planId, message, inspected.pullRequests);
		}
		if (inspected.errors.length > 0) {
			return graphiteSubmitFailure(plan.planId, inspected.errors.join(" "), inspected.pullRequests);
		}
		return {
			status: "completed",
			planId: plan.planId,
			publication: graphitePublication(inspected.pullRequests),
			completedActions: [],
		};
	} finally {
		lock.lock.release();
	}
}
