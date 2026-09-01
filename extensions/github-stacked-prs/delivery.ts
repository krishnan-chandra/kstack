/** GitHub-native stack preflight and publication orchestration. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { commandDiagnostic, type ExecFn, type ExecFnResult, runCommand } from "../shared/git-exec.ts";
import {
	GitHubError,
	type GitHubGateway,
	type GitHubRepository,
	isGitHubIndeterminate,
	type OpenPullRequest,
} from "../shared/github.ts";
import { type acquirePublicationLock, acquireRepositoryPublicationLock } from "../shared/publication-lock.ts";
import type { StackPreflight } from "../shared/stack/channel.ts";
import {
	parseStackManifest,
	type StackManifest,
	type VerifiedStackManifest,
	verifyStackManifestGitFacts,
} from "../shared/stack/manifest.ts";
import type {
	CompletedPublicationAction,
	FailedPublicationAction,
	StackPublicationMap,
	StackPublishOutcome,
} from "../shared/stack/outcome.ts";
import { createNavigationCommentStore } from "../shared/stack/topology.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import type { VcsResult } from "../shared/vcs/backend.ts";
import { preflightVcs } from "../shared/vcs/preflight.ts";
import { requireGit238, resolveGitRemote, resolveGitTrunk, trunkBranchFromManifestRef } from "./repository.ts";

interface PublicationSlice {
	branch: string;
	targetBase: string;
	headSha: string;
	remoteSha: string | undefined;
	existingPr: OpenPullRequest | undefined;
	actions: PublicationAction[];
}

type PublicationAction =
	| { kind: "push-bookmark"; ref: string; headSha: string; expectedRemoteSha?: string }
	| { kind: "create-draft-pr"; ref: string; targetBase: string; title: string }
	| { kind: "repair-pr-base"; ref: string; prNumber: number; targetBase: string }
	| { kind: "mark-pr-ready"; ref: string; prNumber: number };

interface GitHubPublicationPlan {
	planId: string;
	repositoryRoot: string;
	repository: GitHubRepository;
	remote: string;
	defaultBranch: string;
	slices: PublicationSlice[];
	preview: string;
}

interface GitHubPublicationDeps {
	exec: ExecFn;
	gateway: GitHubGateway;
	confirm(title: string, body: string): Promise<boolean>;
	signal?: AbortSignal;
	acquireLock?: typeof acquirePublicationLock;
	realpath?: (path: string) => string;
	readManifest?: (path: string) => string;
}

function childPolicy(input: { trunkRef: string; trunkSha: string; manifestPath?: string }): string {
	if (!input.manifestPath) throw new Error("GitHub stack mode requires a private manifest path.");
	return [
		"# Local GitHub stack policy",
		"Build a local Git branch stack; the parent owns every remote mutation.",
		`Start from ${input.trunkRef} at immutable commit ${input.trunkSha}.`,
		"Create one kstack/<slice> branch per approved PR slice with git switch -c, and record coherent commits on each branch.",
		"Do not push, run gh mutations, or rewrite a published branch.",
		`After every branch or commit change, atomically replace ${input.manifestPath} with schemaVersion 1 JSON containing trunkRef, trunkSha, and ordered slices [{branch, baseBranch, headSha, subject}].`,
		"Leave a clean working tree with the manifest top checked out. The manifest is evidence only; the parent revalidates every fact.",
	].join("\n\n");
}

export async function preflightGitHubStack(
	cwd: string,
	manifestPath: string | undefined,
	exec: ExecFn,
	gateway: GitHubGateway,
): Promise<VcsResult<StackPreflight>> {
	const common = await preflightVcs(cwd, "git", exec);
	if (!common.ok) return common;
	const version = await requireGit238(common.workspaceRoot, exec);
	if (!version.ok) return version;
	const clean = await runCommand(
		exec,
		"git",
		["status", "--porcelain=v1", "--untracked-files=all"],
		common.workspaceRoot,
	);
	if (clean.code !== 0 || clean.stdout.trim()) {
		return {
			ok: false,
			error: "GitHub stack mode requires a clean working tree; commit, stash, or discard existing changes first.",
		};
	}
	if (!manifestPath) return { ok: false, error: "GitHub stack mode requires a private manifest path." };
	const remote = await resolveGitRemote(common.workspaceRoot, "origin", exec);
	if (!remote.ok) return remote;
	const trunk = await resolveGitTrunk({
		cwd: common.workspaceRoot,
		remote: remote.remote,
		exec,
		gateway,
		fetch: true,
	});
	if (!trunk.ok) return trunk;
	return {
		ok: true,
		workspaceRoot: common.workspaceRoot,
		trunkRef: trunk.trunk.ref,
		trunkSha: trunk.trunk.sha,
		childPolicy: childPolicy({ trunkRef: trunk.trunk.ref, trunkSha: trunk.trunk.sha, manifestPath }),
	};
}

export async function planGitHubPublication(input: {
	stack: VerifiedStackManifest;
	remote: string;
	ready: boolean;
	exec: ExecFn;
	gateway: GitHubGateway;
	signal?: AbortSignal;
}): Promise<{ ok: true; plan: GitHubPublicationPlan } | { ok: false; error: string }> {
	const resolved = await resolveGitRemote(input.stack.repositoryRoot, input.remote, input.exec, input.signal);
	if (!resolved.ok) return resolved;
	let openPrs: OpenPullRequest[];
	try {
		openPrs = await input.gateway.listOpenPrs(resolved.remote.repository, input.stack.repositoryRoot, input.signal);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
	const defaultBranch = trunkBranchFromManifestRef(input.stack.manifest.trunkRef);
	const slices: PublicationSlice[] = [];
	const actions: PublicationAction[] = [];
	for (const slice of input.stack.manifest.slices) {
		const matches = openPrs.filter((pr) => pr.headRef === slice.branch);
		if (matches.length > 1) return { ok: false, error: `Multiple open PRs use branch ${slice.branch}.` };
		const existingPr = matches[0];
		let remoteSha: string | undefined;
		try {
			remoteSha = await input.gateway.getRemoteBranchSha(
				resolved.remote.repository,
				slice.branch,
				input.stack.repositoryRoot,
				input.signal,
			);
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
		if (existingPr && remoteSha !== existingPr.headCommitId) {
			return { ok: false, error: `PR #${existingPr.number} head moved while branch ${slice.branch} was inspected.` };
		}
		const targetBase = slice.baseBranch === input.stack.manifest.trunkRef ? defaultBranch : slice.baseBranch;
		const sliceActions: PublicationAction[] = [];
		if (remoteSha !== slice.headSha) {
			sliceActions.push({
				kind: "push-bookmark",
				ref: slice.branch,
				headSha: slice.headSha,
				...(remoteSha ? { expectedRemoteSha: remoteSha } : undefined),
			});
		}
		if (!existingPr) {
			sliceActions.push({ kind: "create-draft-pr", ref: slice.branch, targetBase, title: slice.subject });
		} else {
			if (existingPr.baseRef !== targetBase) {
				sliceActions.push({ kind: "repair-pr-base", ref: slice.branch, prNumber: existingPr.number, targetBase });
			}
			if (input.ready && existingPr.draft) {
				sliceActions.push({ kind: "mark-pr-ready", ref: slice.branch, prNumber: existingPr.number });
			}
		}
		slices.push({
			branch: slice.branch,
			targetBase,
			headSha: slice.headSha,
			remoteSha,
			existingPr,
			actions: sliceActions,
		});
		actions.push(...sliceActions);
	}
	const facts = {
		version: 1,
		repositoryRoot: input.stack.repositoryRoot,
		repository: resolved.remote.repository,
		remote: input.remote,
		defaultBranch,
		manifest: input.stack.manifest,
		slices: slices.map((slice) => ({
			branch: slice.branch,
			remoteSha: slice.remoteSha ?? null,
			prNumber: slice.existingPr?.number ?? null,
			prHead: slice.existingPr?.headCommitId ?? null,
			prBase: slice.existingPr?.baseRef ?? null,
			prDraft: slice.existingPr?.draft ?? null,
		})),
		actions,
	};
	const planId = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
	const preview = [
		`GitHub stack publication ${planId.slice(0, 16)}`,
		...slices.map(
			(slice) =>
				`- ${slice.branch} -> ${slice.targetBase} @ ${slice.headSha.slice(0, 12)}: ${slice.actions.map((action) => action.kind).join(", ") || "already current"}`,
		),
		"Changed remote branches use an exact force-with-lease pin.",
	].join("\n");
	return {
		ok: true,
		plan: {
			planId,
			repositoryRoot: input.stack.repositoryRoot,
			repository: resolved.remote.repository,
			remote: input.remote,
			defaultBranch,
			slices,
			preview,
		},
	};
}

export async function publishGitHubStack(input: {
	cwd: string;
	manifest: StackManifest;
	remote: string;
	ready: boolean;
	authorization: "interactive-confirmation" | "model-tool";
	deps: GitHubPublicationDeps;
}): Promise<StackPublishOutcome> {
	if (input.deps.signal?.aborted) return { status: "cancelled" };
	const verified = await verifyStackManifestGitFacts(
		input.cwd,
		input.manifest,
		input.deps.exec,
		"GitHub",
		input.deps.signal,
	);
	if (input.deps.signal?.aborted) return { status: "cancelled" };
	if (!verified.ok) return blocked(verified.error);
	const planned = await planGitHubPublication({
		stack: verified.stack,
		remote: input.remote,
		ready: input.ready,
		exec: input.deps.exec,
		gateway: input.deps.gateway,
		signal: input.deps.signal,
	});
	if (!planned.ok) return blocked(planned.error);
	const lock = await acquireRepositoryPublicationLock(input.deps.exec, planned.plan.repositoryRoot, {
		acquireLock: input.deps.acquireLock,
		realpath: input.deps.realpath,
		signal: input.deps.signal,
	});
	if (!lock.ok) {
		return lock.kind === "busy"
			? { status: "busy", message: "Another stack publication or landing is active for this repository." }
			: { status: "failed", error: lock.error };
	}
	try {
		const freshFacts = await verifyStackManifestGitFacts(
			input.cwd,
			input.manifest,
			input.deps.exec,
			"GitHub",
			input.deps.signal,
		);
		if (input.deps.signal?.aborted) return { status: "cancelled" };
		if (!freshFacts.ok) return blocked(freshFacts.error, planned.plan.planId);
		const fresh = await planGitHubPublication({
			stack: freshFacts.stack,
			remote: input.remote,
			ready: input.ready,
			exec: input.deps.exec,
			gateway: input.deps.gateway,
			signal: input.deps.signal,
		});
		if (!fresh.ok) return blocked(fresh.error, planned.plan.planId);
		if (fresh.plan.planId !== planned.plan.planId) {
			return { status: "stale", providedPlanId: planned.plan.planId, recomputedPlanId: fresh.plan.planId };
		}
		if (input.authorization === "interactive-confirmation") {
			if (!(await input.deps.confirm("Publish this GitHub stack?", fresh.plan.preview))) {
				return { status: "declined", planId: fresh.plan.planId };
			}
		}
		return applyPublication(fresh.plan, input.ready, input.deps);
	} finally {
		lock.lock.release();
	}
}

export async function publishGitHubManifestFile(input: {
	cwd: string;
	manifestPath: string | undefined;
	remote: string;
	ready: boolean;
	deps: GitHubPublicationDeps;
}): Promise<StackPublishOutcome> {
	if (!input.manifestPath) return { status: "failed", error: "GitHub stack manifest path is unavailable." };
	let raw: string;
	try {
		raw = (input.deps.readManifest ?? ((path) => readFileSync(path, "utf8")))(input.manifestPath);
	} catch (error) {
		return blocked(`Could not read the GitHub stack manifest: ${errorMessage(error)}`);
	}
	const parsed = parseStackManifest(raw);
	if (!parsed.ok) return blocked(parsed.error);
	return publishGitHubStack({
		cwd: input.cwd,
		manifest: parsed.manifest,
		remote: input.remote,
		ready: input.ready,
		authorization: "interactive-confirmation",
		deps: input.deps,
	});
}

async function applyPublication(
	plan: GitHubPublicationPlan,
	ready: boolean,
	deps: GitHubPublicationDeps,
): Promise<StackPublishOutcome> {
	const completed: CompletedPublicationAction[] = [];
	const published = plan.slices.map((slice) => ({
		ref: slice.branch,
		baseRef: slice.targetBase,
		targetBase: slice.targetBase,
		headSha: slice.headSha,
		prNumber: slice.existingPr?.number,
		url: slice.existingPr?.url,
		draft: slice.existingPr?.draft ?? true,
		createPr: !slice.existingPr,
	}));
	const knownPublication = (): StackPublicationMap | undefined => {
		const pullRequests = published
			.filter(
				(slice): slice is typeof slice & { prNumber: number; url: string } =>
					slice.prNumber !== undefined && slice.url !== undefined,
			)
			.map((slice) => ({
				ref: slice.ref,
				baseRef: slice.baseRef,
				headSha: slice.headSha,
				prNumber: slice.prNumber,
				url: slice.url,
				draft: slice.draft,
			}));
		if (pullRequests.length === 0) return undefined;
		return {
			topRef: pullRequests.at(-1)?.ref ?? "",
			remote: plan.remote,
			repository: plan.repository,
			pullRequests,
		};
	};
	const plannedActions = plan.slices.flatMap((slice, index) => slice.actions.map((action) => ({ action, index })));
	const orderedActions = [
		...plannedActions.filter(({ action }) => action.kind === "push-bookmark"),
		...plannedActions.filter(({ action }) => action.kind !== "push-bookmark"),
	];
	for (const { action, index } of orderedActions) {
		if (deps.signal?.aborted) {
			if (completed.length === 0) return { status: "cancelled" };
			return {
				status: "partial",
				planId: plan.planId,
				completedActions: completed,
				publication: knownPublication(),
				failedAction: failedAction(action, new Error("Publication was cancelled before this action started.")),
			};
		}
		try {
			if (action.kind === "push-bookmark") {
				const lease = action.expectedRemoteSha
					? [`--force-with-lease=refs/heads/${action.ref}:${action.expectedRemoteSha}`]
					: [];
				let pushed: ExecFnResult;
				try {
					pushed = await deps.exec("git", ["push", ...lease, plan.remote, `${action.ref}:refs/heads/${action.ref}`], {
						cwd: plan.repositoryRoot,
						signal: deps.signal,
						timeout: 60_000,
					});
				} catch (error) {
					throw new GitHubError(`git push ended without a conclusive result: ${errorMessage(error)}`, "indeterminate");
				}
				if (pushed.code !== 0) {
					throw new GitHubError(`git push failed: ${commandDiagnostic(pushed)}`);
				}
				completed.push({ kind: "push-bookmark", ref: action.ref });
			} else if (action.kind === "create-draft-pr") {
				const created = await deps.gateway.createDraftPr({
					repo: plan.repository,
					ref: action.ref,
					base: action.targetBase,
					title: action.title,
					body: `Stack slice \`${action.ref}\` published by kstack.`,
					cwd: plan.repositoryRoot,
					signal: deps.signal,
				});
				published[index].prNumber = created.number;
				published[index].url = created.url;
				published[index].draft = created.draft;
				completed.push({ kind: "create-draft-pr", ref: action.ref, prNumber: created.number, url: created.url });
				if (ready && created.draft) {
					await deps.gateway.markPrReady(plan.repository, created.number, plan.repositoryRoot, deps.signal);
					published[index].draft = false;
					completed.push({ kind: "mark-pr-ready", ref: action.ref, prNumber: created.number });
				}
			} else if (action.kind === "repair-pr-base") {
				await deps.gateway.updatePrBase({
					repo: plan.repository,
					prNumber: action.prNumber,
					base: action.targetBase,
					cwd: plan.repositoryRoot,
					signal: deps.signal,
				});
				completed.push({
					kind: "repair-pr-base",
					ref: action.ref,
					prNumber: action.prNumber,
					targetBase: action.targetBase,
				});
			} else {
				await deps.gateway.markPrReady(plan.repository, action.prNumber, plan.repositoryRoot, deps.signal);
				published[index].draft = false;
				completed.push({ kind: "mark-pr-ready", ref: action.ref, prNumber: action.prNumber });
			}
		} catch (error) {
			const failed = failedAction(action, error);
			if (isGitHubIndeterminate(error)) {
				return {
					status: "indeterminate",
					planId: plan.planId,
					inFlight: failed,
					completedActions: completed,
					publication: knownPublication(),
					recovery: "Inspect remote branches and PRs, then publish again from a fresh plan.",
				};
			}
			if (completed.length === 0) return { status: "failed", error: failed.error, completedActions: [] };
			return {
				status: "partial",
				planId: plan.planId,
				completedActions: completed,
				publication: knownPublication(),
				failedAction: failed,
			};
		}
	}
	const proven = published.filter(
		(slice): slice is typeof slice & { prNumber: number; url: string } =>
			slice.prNumber !== undefined && slice.url !== undefined,
	);
	if (proven.length !== published.length) {
		return {
			status: "partial",
			planId: plan.planId,
			completedActions: completed,
			publication: knownPublication(),
			failedAction: { kind: "create-draft-pr", error: "A published PR could not be proven." },
		};
	}
	const comments = await createNavigationCommentStore(deps.gateway).reconcile({
		repo: plan.repository,
		defaultBranch: plan.defaultBranch,
		published,
		cwd: plan.repositoryRoot,
		signal: deps.signal,
	});
	const commentErrors = [...comments.errors];
	if (comments.indeterminate) commentErrors.push(comments.indeterminate.error);
	const publication: StackPublicationMap = {
		topRef: plan.slices.at(-1)?.branch ?? "",
		remote: plan.remote,
		repository: plan.repository,
		pullRequests: proven.map((slice) => ({
			ref: slice.ref,
			baseRef: slice.baseRef,
			headSha: slice.headSha,
			prNumber: slice.prNumber,
			url: slice.url,
			draft: slice.draft,
		})),
	};
	return {
		status: "completed",
		planId: plan.planId,
		publication,
		completedActions: [...completed, ...comments.completed],
		...(commentErrors.length > 0 ? { commentErrors } : undefined),
	};
}

function blocked(message: string, planId?: string): StackPublishOutcome {
	return { status: "blocked", blockers: [{ code: "github-publish", message }], ...(planId ? { planId } : undefined) };
}

function failedAction(action: PublicationAction, error: BoundaryValue): FailedPublicationAction {
	return {
		kind: action.kind,
		ref: action.ref,
		...(action.kind === "repair-pr-base" || action.kind === "mark-pr-ready"
			? { prNumber: action.prNumber }
			: undefined),
		error: errorMessage(error),
	};
}

function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}
