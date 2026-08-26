import { readFileSync } from "node:fs";
/** Validated local Graphite stack evidence and parent-owned publication. */

import { createHash } from "node:crypto";
import { commandDiagnostic, type ExecFn, type ExecFnResult, runCommand } from "../shared/git-exec.ts";
import { type acquirePublicationLock, acquireRepositoryPublicationLock } from "../shared/publication-lock.ts";
import type { StackPreflight } from "../shared/stack/channel.ts";
import {
	parseStackManifest,
	STACK_SHA_RE,
	type StackManifest,
	type VerifiedStackManifest,
	verifyStackManifestGitFacts,
} from "../shared/stack/manifest.ts";
import type { StackPublicationMap, StackPublishOutcome } from "../shared/stack/outcome.ts";
import type { VcsResult } from "../shared/vcs/backend.ts";
import { verifyGraphiteDryRunAffectedRefs } from "../shared/vcs/graphite-dry-run.ts";
import { preflightVcs } from "../shared/vcs/preflight.ts";
import { type GraphiteOpenPullRequest, queryOpenPullRequests } from "./pull-requests.ts";

/* exported: Graphite stack-delivery contract */
export type GraphitePublishedPullRequest = Omit<GraphiteOpenPullRequest, "number"> & { prNumber: number };

interface ExistingPullRequest extends GraphitePublishedPullRequest {
	state: "OPEN";
}

/* exported: Graphite stack-delivery contract */
export interface GraphitePublicationPlan {
	planId: string;
	repositoryRoot: string;
	manifest: StackManifest;
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

function graphiteChildPolicy(input: { trunkRef: string; trunkSha: string; manifestPath?: string }): string {
	if (!input.manifestPath) throw new Error("Graphite stack mode requires a private manifest path.");
	return [
		"# Local Graphite stack policy",
		"Build a local stack with native gt only; the parent owns publication.",
		`Start from ${input.trunkRef} at immutable commit ${input.trunkSha}.`,
		"Create one kstack/<slice> branch per approved PR slice with gt create, and record changes with gt add/gt modify.",
		"Do not run gt submit, gt merge, gh mutations, git commit, git branch, git rebase, or git push.",
		`After every create, modify, or restack, atomically replace ${input.manifestPath} with schemaVersion 1 JSON containing trunkRef, trunkSha, and the ordered slices [{branch, baseBranch, headSha, subject}].`,
		"Leave a clean working tree with the manifest's top branch checked out. The manifest is evidence only; the parent revalidates every fact.",
	].join("\n\n");
}

export async function preflightGraphiteStack(
	cwd: string,
	manifestPath: string | undefined,
	exec: ExecFn,
): Promise<VcsResult<StackPreflight>> {
	const common = await preflightVcs(cwd, "graphite", exec);
	if (!common.ok) return common;
	let trunk: ExecFnResult;
	try {
		const status = await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
			cwd: common.workspaceRoot,
			timeout: 8_000,
		});
		if (status.code !== 0 || status.stdout.length > 0) {
			return {
				ok: false,
				error: "Graphite stack mode requires a clean working tree; commit, stash, or discard existing changes first.",
			};
		}
		trunk = await exec("gt", ["--no-interactive", "trunk"], {
			cwd: common.workspaceRoot,
			timeout: 8_000,
		});
	} catch (error) {
		return {
			ok: false,
			error: `Could not resolve the Graphite trunk: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const trunkRef = trunk.stdout.trim();
	if (trunk.code !== 0 || !trunkRef) return { ok: false, error: "Could not resolve the Graphite trunk." };
	const head = await exec("git", ["rev-parse", "--verify", `refs/heads/${trunkRef}^{commit}`], {
		cwd: common.workspaceRoot,
		timeout: 8_000,
	});
	const trunkSha = head.stdout.trim();
	if (head.code !== 0 || !STACK_SHA_RE.test(trunkSha)) {
		return { ok: false, error: `Could not resolve Graphite trunk ${trunkRef}.` };
	}
	if (!manifestPath) return { ok: false, error: "Graphite stack mode requires a private manifest path." };
	const childPolicy = graphiteChildPolicy({ trunkRef, trunkSha, manifestPath });
	return {
		ok: true,
		workspaceRoot: common.workspaceRoot,
		trunkRef,
		trunkSha,
		childPolicy,
	};
}

/** Recheck manifest evidence against immutable Git facts and a Graphite dry run. */
export async function verifyGraphiteStack(
	cwd: string,
	manifest: StackManifest,
	exec: ExecFn,
	signal?: AbortSignal,
): Promise<{ ok: true; stack: VerifiedStackManifest } | { ok: false; error: string }> {
	const gitFacts = await verifyStackManifestGitFacts(cwd, manifest, exec, "Graphite", signal);
	if (!gitFacts.ok) return gitFacts;
	const { repositoryRoot } = gitFacts.stack;
	const dryRun = await runCommand(
		exec,
		"gt",
		["--no-interactive", "--no-ai", "submit", "--stack", "--draft", "--no-edit", "--dry-run"],
		repositoryRoot,
		signal,
		60_000,
	);
	if (dryRun.code !== 0)
		return { ok: false, error: `gt submit --stack --dry-run failed: ${commandDiagnostic(dryRun)}` };
	const scope = verifyGraphiteDryRunAffectedRefs(
		`${dryRun.stdout}\n${dryRun.stderr}`,
		"submit",
		manifest.slices.map((slice) => slice.branch),
	);
	if (!scope.ok) return { ok: false, error: `Refusing Graphite stack publication: ${scope.error}` };
	return { ok: true, stack: { repositoryRoot, manifest } };
}

async function existingForRef(
	exec: ExecFn,
	cwd: string,
	ref: string,
): Promise<{ ok: true; pr?: ExistingPullRequest } | { ok: false; error: string }> {
	const result = await queryOpenPullRequests({ exec, cwd, filter: ["--head", ref], limit: 2 });
	if (!result.ok) return { ok: false, error: `Could not inspect GitHub PR for ${ref}: ${result.error}` };
	if (result.pullRequests.some((pr) => pr.ref !== ref)) {
		return { ok: false, error: `GitHub returned invalid PR data for ${ref}.` };
	}
	if (result.pullRequests.length > 1) {
		return {
			ok: false,
			error: `Expected at most one open PR for ${ref}; found ${result.pullRequests.length}.`,
		};
	}
	const found = result.pullRequests[0];
	if (!found) return { ok: true };
	return {
		ok: true,
		pr: {
			state: "OPEN",
			ref: found.ref,
			baseRef: found.baseRef,
			headSha: found.headSha,
			prNumber: found.number,
			url: found.url,
			draft: found.draft,
		},
	};
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
	stack: VerifiedStackManifest,
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
	deps: { acquireLock?: typeof acquirePublicationLock; realpath?: (path: string) => string; signal?: AbortSignal } = {},
): Promise<StackPublishOutcome> {
	const lock = await acquireRepositoryPublicationLock(exec, plan.repositoryRoot, deps);
	if (!lock.ok) {
		return lock.kind === "busy"
			? { status: "busy", message: "Another Graphite publication or landing is active for this repository." }
			: { status: "failed", error: lock.error };
	}
	try {
		const verified = await verifyGraphiteStack(plan.repositoryRoot, plan.manifest, exec, deps.signal);
		if (deps.signal?.aborted) return { status: "cancelled", completedActions: [] };
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
				signal: deps.signal,
			});
		} catch (error) {
			const inspected = await inspectPublishedStack(exec, plan);
			const message = `gt submit may have started before the process failed: ${error instanceof Error ? error.message : String(error)} ${inspected.errors.join(" ")}`;
			return graphiteSubmitFailure(plan.planId, message, inspected.pullRequests);
		}
		const inspected = await inspectPublishedStack(exec, plan);
		if (submitted.code !== 0) {
			const message = `gt submit --stack returned ${commandDiagnostic(submitted)} after publication began. ${inspected.errors.join(" ")}`;
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

export async function publishGraphiteStack(
	cwd: string,
	manifestPath: string | undefined,
	confirm: (title: string, body: string) => Promise<boolean>,
	exec: ExecFn,
	signal?: AbortSignal,
): Promise<StackPublishOutcome> {
	if (!manifestPath) return { status: "failed", error: "Graphite stack manifest path is unavailable." };
	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch (error) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "graphite-publish",
					message: `Could not read the Graphite stack manifest: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}
	const parsed = parseStackManifest(raw);
	if (!parsed.ok) return { status: "blocked", blockers: [{ code: "graphite-publish", message: parsed.error }] };
	const verified = await verifyGraphiteStack(cwd, parsed.manifest, exec, signal);
	if (signal?.aborted) return { status: "cancelled" };
	if (!verified.ok) return { status: "blocked", blockers: [{ code: "graphite-publish", message: verified.error }] };
	const planned = await planGraphitePublication(verified.stack, exec);
	if (!planned.ok) return { status: "blocked", blockers: [{ code: "graphite-publish", message: planned.error }] };
	if (!(await confirm("Publish this Graphite stack?", planned.plan.preview))) return { status: "declined" };
	return submitGraphiteStack(planned.plan, exec, { signal });
}
