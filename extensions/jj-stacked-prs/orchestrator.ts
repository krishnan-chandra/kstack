import type { BoundaryValue } from "../shared/validation.ts";
/** Inspect, plan, publish, sync, and advance state machines. */

import { realpathSync } from "node:fs";
import type { LandResult } from "../land/types.ts";
import { GitHubError, type GitHubGateway } from "../shared/github.ts";
import { acquireRepositoryPublicationLock, type LockAttempt } from "../shared/publication-lock.ts";
import type {
	CompletedPublicationAction,
	FailedPublicationAction,
	StackPublishedPullRequest,
	StackPublishOutcome,
} from "../shared/stack/outcome.ts";
import { createNavigationCommentStore } from "../shared/stack/topology.ts";
import { createJjGitHubGateway, execFromRunner } from "./github-gateway.ts";
import { bookmarkRevset, createJjAdapter, type JjAdapter, JjError } from "./jj.ts";
import { type PrDocument, renderPrDocument } from "./pr-document.ts";
import type { PrMetadata, PrMetadataGenerator } from "./pr-metadata.ts";
import {
	discoverRepositoryPrTemplate,
	type RepositoryPrTemplate,
	renderRepositoryPrTemplate,
	validatePrMetadataAgainstTemplate,
} from "./pr-template.ts";
import type { ProcessRunner } from "./process.ts";
import { buildPublicationPlan, type PublicationSnapshot, slicesForPublication } from "./publication.ts";
import { renderConfirmation } from "./render.ts";
import { detectBlockers, inferUniqueTop, truncateStack } from "./stack.ts";
import {
	type AdvanceOutcome,
	DEFAULT_MAX_STACK,
	type InspectModel,
	type PublicationPlan,
	SCHEMA_VERSION,
	type StackBlocker,
	type StackCommit,
	type StackMergeMethod,
	type StackPublicationRequestInput,
	type StackReadinessMode,
	type SyncOutcome,
} from "./types.ts";

export interface StackUi {
	hasUI: boolean;
	confirm(title: string, body: string): Promise<boolean>;
	select(title: string, values: string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	setStatus(status: string | undefined): void;
}

export interface OrchestratorDeps {
	jj?: JjAdapter;
	github?: GitHubGateway;
	run: ProcessRunner;
	ui: StackUi;
	signal?: AbortSignal;
	realpath?: (path: string) => string;
	/** Delegated exact-head request into Land's single-PR implementation. */
	landFrontier?: (input: {
		prNumber: number;
		expectedHeadSha: string;
		readiness: StackReadinessMode;
		method: StackMergeMethod;
	}) => Promise<{ handled: false } | { handled: true; outcome: LandResult }>;
	configuredMethodFor?: (nameWithOwner: string) => StackMergeMethod | undefined;
	generatePrMetadata?: PrMetadataGenerator;
	loadRepositoryPrTemplate?: (cwd: string) => RepositoryPrTemplate | undefined;
	acquirePublicationLock?: (repositoryPath: string) => LockAttempt;
}

interface InspectOptions {
	cwd: string;
	top?: string;
	trunk?: string;
	maxStack?: number;
}

interface PlanOptions extends InspectOptions {
	remote: string;
}

interface PublishOptions extends PlanOptions {
	ready?: boolean;
}

interface SyncOptions {
	cwd: string;
	top: string;
	remote: string;
	trunk?: string;
	maxStack?: number;
}

interface AdvanceOptions extends SyncOptions {
	merged: string;
}

export async function inspectStack(options: InspectOptions, deps: OrchestratorDeps): Promise<InspectModel> {
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const trunkRevset = options.trunk ?? "trunk()";
	const maxStack = options.maxStack ?? DEFAULT_MAX_STACK;
	const preflight = await jj.preflight(options.cwd, deps.signal);
	const trunkCommit = await jj.resolveRevset(options.cwd, trunkRevset, deps.signal);
	const localBookmarks = await jj.listLocalBookmarks(options.cwd, deps.signal);
	let top = options.top;
	if (top && !localBookmarks.some((bookmark) => bookmark.name === top)) {
		return inspectFailure(preflight.jjVersion, trunkRevset, trunkCommit, localBookmarks, maxStack, [
			{
				code: "missing-top",
				message: `Bookmark ${JSON.stringify(top)} does not exist locally. Available: ${
					localBookmarks
						.map((bookmark) => bookmark.name)
						.sort()
						.join(", ") || "(none)"
				}.`,
			},
		]);
	}
	const preliminaryRevset = `(${trunkRevset})..${top ? bookmarkRevset(top) : "@"}`;
	let commits = await jj.fetchStack(options.cwd, preliminaryRevset, deps.signal);
	const wcChange = await jj.workingCopyChangeId(options.cwd, deps.signal);
	let topCommitId: string | undefined;
	if (top) topCommitId = await jj.resolveRevset(options.cwd, bookmarkRevset(top), deps.signal);
	else {
		const inferred = inferUniqueTop(markWorkingCopy(commits, wcChange));
		if ("top" in inferred) {
			top = inferred.top;
			topCommitId = await jj.resolveRevset(options.cwd, bookmarkRevset(top), deps.signal);
			commits = await jj.fetchStack(options.cwd, `(${trunkRevset})..${bookmarkRevset(top)}`, deps.signal);
		}
	}
	const truncated = truncateStack(commits, maxStack);
	const stack = markWorkingCopy(truncated.items, wcChange);
	const blockers = detectBlockers({ commits: stack, trunkCommit, topBookmark: top });
	if (truncated.truncated) {
		blockers.unshift({ code: "truncated", message: "The stack is truncated; publish refused on incomplete data." });
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		jjVersion: preflight.jjVersion,
		trunk: { revset: trunkRevset, commitId: trunkCommit },
		top,
		topCommitId,
		localBookmarks: localBookmarks.map((bookmark) => bookmark.name).sort(),
		stack,
		slices: top ? slicesOrEmpty(stack, top) : [],
		truncated: truncated.truncated,
		maxStack,
		blockers,
	};
}

export async function planStack(
	options: PlanOptions,
	deps: OrchestratorDeps,
): Promise<
	| { status: "ok"; plan: PublicationPlan; model: InspectModel }
	| { status: "blocked"; blockers: StackBlocker[]; model: InspectModel }
> {
	const model = await inspectStack(options, deps);
	const blocked = publicationBlockers(model);
	if (blocked.length > 0) return { status: "blocked", blockers: blocked, model };
	const snapshot = await snapshotPublication(model, options, deps);
	if ("blockers" in snapshot) return { status: "blocked", blockers: snapshot.blockers, model };
	const plan = buildPublicationPlan(snapshot.snapshot);
	if (plan.blockers.length > 0) return { status: "blocked", blockers: [...plan.blockers], model };
	return { status: "ok", plan, model };
}

export async function publishStack(options: PublishOptions, deps: OrchestratorDeps): Promise<StackPublishOutcome> {
	return publishStackWithAuthorization(options, deps, "interactive-confirmation");
}

/** Publish after an explicit model tool call, without a second UI confirmation. */
export async function publishStackFromTool(
	options: PublishOptions,
	deps: OrchestratorDeps,
): Promise<StackPublishOutcome> {
	return publishStackWithAuthorization(options, deps, "model-tool");
}

async function publishStackWithAuthorization(
	options: PublishOptions,
	deps: OrchestratorDeps,
	authorization: "interactive-confirmation" | "model-tool",
): Promise<StackPublishOutcome> {
	if (authorization === "interactive-confirmation" && !deps.ui.hasUI) {
		return {
			status: "blocked",
			blockers: [{ code: "missing-remote", message: "Publication requires interactive TUI/RPC mode." }],
		};
	}
	if (deps.signal?.aborted) return { status: "cancelled" };
	const planned = await planStack(options, deps);
	if (planned.status === "blocked") return { status: "blocked", blockers: planned.blockers };
	if (authorization === "interactive-confirmation") {
		const confirmation = renderConfirmation(planned.plan);
		if (!confirmation.ok) {
			return { status: "blocked", blockers: [{ code: "truncated", message: confirmation.reason }] };
		}
		deps.ui.setStatus("jj-stack: confirm publication");
		const confirmed = await deps.ui.confirm("Publish this stacked PR plan?", confirmation.body);
		if (deps.signal?.aborted) return { status: "cancelled" };
		if (!confirmed) return { status: "declined", planId: planned.plan.planId };
	}
	const injectedAcquireLock = deps.acquirePublicationLock;
	const acquireLock = injectedAcquireLock
		? ({ repositoryPath }: { repositoryPath: string }) => injectedAcquireLock(repositoryPath)
		: undefined;
	const lockAttempt = await acquireRepositoryPublicationLock(execFromRunner(deps.run), options.cwd, {
		acquireLock,
		realpath: deps.realpath,
		signal: deps.signal,
	});
	if (!lockAttempt.ok) {
		if (lockAttempt.kind === "failed") {
			return { status: "failed", error: `Unable to acquire publication lock: ${lockAttempt.error}` };
		}
		const detail = lockAttempt.holder ? ` (pid ${lockAttempt.holder.pid}, since ${lockAttempt.holder.startedAt})` : "";
		return {
			status: "blocked",
			blockers: [
				{
					code: "publication-locked",
					message: `Another kstack publication is in progress for this repository${detail}. Retry after it finishes.`,
				},
			],
		};
	}
	try {
		const fresh = await planStack(options, deps);
		if (fresh.status === "blocked") return { status: "blocked", blockers: fresh.blockers, planId: planned.plan.planId };
		if (fresh.plan.planId !== planned.plan.planId) {
			return { status: "stale", providedPlanId: planned.plan.planId, recomputedPlanId: fresh.plan.planId };
		}
		deps.ui.setStatus("jj-stack: publishing");
		return await applyPublication(fresh.plan, options, deps);
	} finally {
		const released = lockAttempt.lock.release();
		if (!released.ok) {
			deps.ui.notify(
				`Publication lock cleanup failed: ${released.error}. Remove the lock file manually if later publications block.`,
				"warning",
			);
		}
	}
}

export async function syncStack(options: SyncOptions, deps: OrchestratorDeps): Promise<SyncOutcome> {
	if (!deps.ui.hasUI)
		return {
			status: "blocked",
			blockers: [{ code: "missing-remote", message: "Sync requires interactive TUI/RPC mode." }],
		};
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const model = await inspectStack(options, deps);
	const blockers = model.blockers.filter((blocker) =>
		["conflict", "divergence", "merge", "truncated", "top-not-final-boundary", "missing-top", "empty-stack"].includes(
			blocker.code,
		),
	);
	if (blockers.length > 0) return { status: "blocked", blockers };
	const operationId = await jj.currentOperationId(options.cwd, deps.signal);
	const confirmed = await deps.ui.confirm(
		"Fetch and rebase the selected stack?",
		`Remote: ${options.remote}\nTop: ${options.top}\n\njj git fetch --remote ${options.remote}\njj rebase -b ${options.top} -o ${options.trunk ?? "trunk()"}`,
	);
	if (deps.signal?.aborted) return { status: "cancelled", operationId };
	if (!confirmed) return { status: "declined" };
	let mutationCompleted = false;
	try {
		await jj.fetchRemote(options.cwd, options.remote, deps.signal);
		mutationCompleted = true;
		const trunk = await jj.resolveRevset(options.cwd, options.trunk ?? "trunk()", deps.signal);
		await jj.rebaseStack(options.cwd, options.top, trunk, deps.signal);
		const after = await inspectStack(options, deps);
		const remaining = after.blockers.filter((blocker) => ["conflict", "divergence", "merge"].includes(blocker.code));
		return remaining.length > 0
			? { status: "partial", operationId, blockers: remaining, error: "Rebase recorded conflicts or other blockers." }
			: { status: "completed", operationId, blockers: after.blockers };
	} catch (error) {
		return mutationFailure(error, deps.signal, operationId, "sync", mutationCompleted);
	}
}

export async function advanceStack(options: AdvanceOptions, deps: OrchestratorDeps): Promise<AdvanceOutcome> {
	if (!deps.ui.hasUI)
		return {
			status: "blocked",
			blockers: [{ code: "missing-remote", message: "Advance requires interactive TUI/RPC mode." }],
		};
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const github = deps.github ?? createJjGitHubGateway(deps.run);
	const model = await inspectStack(options, deps);
	if (model.blockers.length > 0) return { status: "blocked", blockers: model.blockers };
	if (!model.top || !model.slices.some((slice) => slice.bookmark === options.merged)) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "top-not-final-boundary",
					message: `Merged bookmark ${JSON.stringify(options.merged)} is not a current boundary in ${model.trunk.revset}..${options.top}.`,
				},
			],
		};
	}
	const remote = await jj.getRemote(options.cwd, options.remote, deps.signal);
	if (!remote.github) {
		return {
			status: "blocked",
			blockers: [{ code: "non-github-remote", message: `Remote ${options.remote} is not a GitHub repository.` }],
		};
	}
	const matches = await github.listPrsForHead(remote.github, options.merged, options.cwd, deps.signal);
	let status: string;
	if (matches.length === 1) {
		status = await github.getPrStatus(remote.github, matches[0].number, options.cwd, deps.signal);
	} else if (matches.length > 1) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "ambiguous-pr",
					message: `Multiple open PRs use bookmark ${JSON.stringify(options.merged)}.`,
					ref: options.merged,
				},
			],
		};
	} else {
		return {
			status: "blocked",
			blockers: [
				{
					code: "ambiguous-pr",
					message: `Could not resolve exactly one PR for merged bookmark ${JSON.stringify(options.merged)}.`,
					ref: options.merged,
				},
			],
		};
	}
	const mergedCommit = model.stack.find((commit) => commit.bookmarks.includes(options.merged));
	if (!mergedCommit || matches[0].headCommitId !== mergedCommit.commitId) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "ambiguous-pr",
					message: `PR #${matches[0].number} head ${matches[0].headCommitId} does not match local bookmark ${JSON.stringify(options.merged)} at ${mergedCommit?.commitId ?? "an unknown commit"}. Refusing to abandon reused or unpublished history.`,
					ref: options.merged,
				},
			],
		};
	}
	if (status !== "merged") {
		return {
			status: "blocked",
			blockers: [
				{
					code: "ambiguous-pr",
					message: `GitHub reports PR for ${JSON.stringify(options.merged)} as ${status}, not merged.`,
					ref: options.merged,
				},
			],
		};
	}
	const mergedIndex = model.slices.findIndex((slice) => slice.bookmark === options.merged);
	if (mergedIndex !== 0) {
		const predecessors = model.slices
			.slice(0, mergedIndex)
			.map((slice) => slice.bookmark)
			.join(", ");
		return {
			status: "blocked",
			blockers: [
				{
					code: "top-not-final-boundary",
					message: `Merged bookmark ${JSON.stringify(options.merged)} is not the bottom of the stack; abandoning it would delete unmerged predecessor(s) ${predecessors}.`,
				},
			],
		};
	}
	const trunkRevset = options.trunk ?? "trunk()";
	const operationId = await jj.currentOperationId(options.cwd, deps.signal);
	const confirmed = await deps.ui.confirm(
		"Advance the stack past the merged bookmark?",
		`Abandon ${trunkRevset}..${options.merged} before fetch.\nThen: jj git fetch --remote ${options.remote}\nThen rebase remaining -b ${options.top} onto ${trunkRevset} if anything remains.\nRecovery: jj op restore ${operationId}`,
	);
	if (deps.signal?.aborted) return { status: "cancelled", operationId };
	if (!confirmed) return { status: "declined" };
	return applyAdvance(options, deps, {
		jj,
		operationId,
		trunkCommitId: model.trunk.commitId,
		trunkRevset,
	});
}

export async function applyAdvance(
	options: AdvanceOptions,
	deps: OrchestratorDeps,
	input: { jj: JjAdapter; operationId: string; trunkCommitId: string; trunkRevset: string },
): Promise<AdvanceOutcome> {
	let mutationCompleted = false;
	try {
		await input.jj.abandonRange(options.cwd, input.trunkCommitId, options.merged, deps.signal);
		mutationCompleted = true;
		await input.jj.fetchRemote(options.cwd, options.remote, deps.signal);
		if (options.merged === options.top) {
			return { status: "completed", operationId: input.operationId, blockers: [] };
		}
		const trunk = await input.jj.resolveRevset(options.cwd, input.trunkRevset, deps.signal);
		await input.jj.rebaseStack(options.cwd, options.top, trunk, deps.signal);
		const after = await inspectStack({ ...options, top: options.top }, deps);
		const remaining = after.blockers.filter((blocker) => ["conflict", "divergence", "merge"].includes(blocker.code));
		return remaining.length > 0
			? {
					status: "partial",
					operationId: input.operationId,
					blockers: remaining,
					error: "Rebase recorded conflicts or other blockers.",
				}
			: { status: "completed", operationId: input.operationId, remainingTop: options.top, blockers: after.blockers };
	} catch (error) {
		return mutationFailure(error, deps.signal, input.operationId, "advance", mutationCompleted);
	}
}

export async function requestPublicationFromInput(
	input: StackPublicationRequestInput,
	deps: OrchestratorDeps,
): Promise<StackPublishOutcome> {
	const cwd = canonicalize(input.repositoryPath, deps.realpath);
	const signal =
		deps.signal && input.signal ? AbortSignal.any([deps.signal, input.signal]) : (deps.signal ?? input.signal);
	const requestDeps = { ...deps, signal };
	let top = input.topBookmark;
	if (!top) {
		const inspect = await inspectStack({ cwd, trunk: input.trunkRevset }, requestDeps);
		const inferred = inferUniqueTop(inspect.stack);
		if ("blocker" in inferred) return { status: "blocked", blockers: [inferred.blocker] };
		top = inferred.top;
	}
	let remote = input.remote;
	if (!remote) {
		const jj = deps.jj ?? createJjAdapter(deps.run);
		const remotes = (await jj.listRemotes(cwd, signal)).filter((candidate) => candidate.github);
		if (remotes.length === 1) remote = remotes[0].name;
		else if (remotes.length === 0) {
			return { status: "blocked", blockers: [{ code: "missing-remote", message: "No GitHub remote exists." }] };
		} else if (!deps.ui.hasUI) {
			return {
				status: "blocked",
				blockers: [{ code: "ambiguous-remote", message: "Multiple GitHub remotes exist; specify remote." }],
			};
		} else {
			remote = await deps.ui.select(
				"Select the GitHub remote to publish",
				remotes.map((item) => item.name),
			);
			if (!remote) return { status: "declined" };
		}
	}
	return publishStack({ cwd, top, remote, trunk: input.trunkRevset }, requestDeps);
}

async function applyPublication(
	plan: PublicationPlan,
	options: PublishOptions,
	deps: OrchestratorDeps,
): Promise<StackPublishOutcome> {
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const github = deps.github ?? createJjGitHubGateway(deps.run);
	const metadataByBookmark = new Map<string, PrMetadata>();
	const slicesNeedingMetadata = plan.slices.filter((slice) =>
		slice.actions.some((action) => action.kind === "create-draft-pr"),
	);
	let repositoryTemplate: RepositoryPrTemplate | undefined;
	if (slicesNeedingMetadata.length > 0) {
		try {
			repositoryTemplate = (deps.loadRepositoryPrTemplate ?? discoverRepositoryPrTemplate)(options.cwd);
		} catch (error) {
			return { status: "failed", error: errorMessage(error), completedActions: [] };
		}
		if (deps.signal?.aborted) return { status: "cancelled", completedActions: [] };
		const controller = new AbortController();
		const generationSignal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
		try {
			const results = await Promise.all(
				slicesNeedingMetadata.map(async (slice) => {
					try {
						const metadata = deps.generatePrMetadata
							? await deps.generatePrMetadata({
									cwd: options.cwd,
									bookmark: slice.bookmark,
									baseRevset: slice.baseBookmark ? bookmarkRevset(slice.baseBookmark) : (options.trunk ?? "trunk()"),
									subject: slice.subject,
									changeIds: slice.changeIds,
									repositoryTemplate,
									signal: generationSignal,
								})
							: provisionalPrMetadata(slice.subject, slice.bookmark, repositoryTemplate);
						if (repositoryTemplate) validatePrMetadataAgainstTemplate(metadata, repositoryTemplate);
						return [slice.bookmark, metadata] as const;
					} catch (error) {
						controller.abort();
						throw new Error(
							`Could not generate PR metadata for ${JSON.stringify(slice.bookmark)}: ${errorMessage(error)}`,
						);
					}
				}),
			);
			for (const [bookmark, metadata] of results) {
				metadataByBookmark.set(bookmark, metadata);
			}
		} catch (error) {
			if (deps.signal?.aborted) return { status: "cancelled", completedActions: [] };
			return {
				status: "failed",
				error: errorMessage(error),
				completedActions: [],
			};
		} finally {
			controller.abort();
		}
		const fresh = await planStack(options, deps);
		if (fresh.status === "blocked") return { status: "blocked", blockers: fresh.blockers, planId: plan.planId };
		if (fresh.plan.planId !== plan.planId) {
			return { status: "stale", providedPlanId: plan.planId, recomputedPlanId: fresh.plan.planId };
		}
	}
	const completed: CompletedPublicationAction[] = [];
	const published = plan.slices.map((slice) => ({
		bookmark: slice.bookmark,
		baseBookmark: slice.baseBookmark,
		changeIds: slice.changeIds,
		prNumber: slice.existingPr?.number,
		url: slice.existingPr?.url,
		draft: slice.existingPr?.draft ?? true,
		targetBase: slice.targetBase,
		createPr: slice.existingPr === undefined,
	}));

	for (const [index, slice] of plan.slices.entries()) {
		for (const action of slice.actions) {
			if (deps.signal?.aborted) return { status: "cancelled", completedActions: completed };
			try {
				if (action.kind === "push-bookmark") {
					await jj.pushBookmark(options.cwd, options.remote, action.bookmark, deps.signal);
					completed.push({ kind: "push-bookmark", ref: action.bookmark });
				} else if (action.kind === "create-draft-pr") {
					const metadata = metadataByBookmark.get(action.bookmark);
					if (!metadata) throw new Error(`No PR metadata was prepared for ${JSON.stringify(action.bookmark)}.`);
					const created = await github.createDraftPr({
						repo: plan.repository,
						bookmark: action.bookmark,
						base: action.targetBase.replace(/^refs\/heads\//, ""),
						title: metadata.title,
						body: metadata.body,
						cwd: options.cwd,
						signal: deps.signal,
					});
					published[index].prNumber = created.number;
					published[index].url = created.url;
					published[index].draft = created.draft;
					completed.push({
						kind: "create-draft-pr",
						ref: action.bookmark,
						prNumber: created.number,
						url: created.url,
					});
				} else {
					await github.updatePrBase({
						repo: plan.repository,
						prNumber: action.prNumber,
						base: action.targetBase.replace(/^refs\/heads\//, ""),
						cwd: options.cwd,
						signal: deps.signal,
					});
					completed.push({
						kind: "repair-pr-base",
						ref: action.bookmark,
						prNumber: action.prNumber,
						targetBase: action.targetBase,
					});
				}
			} catch (error) {
				const failed = toFailedAction(action.kind, error, slice.bookmark);
				if (isIndeterminate(error) || deps.signal?.aborted) {
					return {
						status: "indeterminate",
						planId: plan.planId,
						inFlight: failed,
						completedActions: completed,
						recovery: "Re-run /jj-stack plan and inspect remote state before retrying.",
					};
				}
				return {
					status: "partial",
					planId: plan.planId,
					completedActions: completed,
					failedAction: failed,
				};
			}
		}
	}

	if (options.ready) {
		for (const slice of published) {
			if (slice.prNumber === undefined || !slice.draft) continue;
			if (deps.signal?.aborted) return { status: "cancelled", completedActions: completed };
			try {
				await github.markPrReady(plan.repository, slice.prNumber, options.cwd, deps.signal);
				slice.draft = false;
				completed.push({ kind: "mark-pr-ready", ref: slice.bookmark, prNumber: slice.prNumber });
			} catch (error) {
				const failed = {
					kind: "mark-pr-ready" as const,
					ref: slice.bookmark,
					prNumber: slice.prNumber,
					error: errorMessage(error),
				};
				if (isIndeterminate(error) || deps.signal?.aborted) {
					return {
						status: "indeterminate",
						planId: plan.planId,
						inFlight: failed,
						completedActions: completed,
						recovery: "Re-run /jj-stack plan and inspect remote state before retrying.",
					};
				}
				return {
					status: "partial",
					planId: plan.planId,
					completedActions: completed,
					failedAction: failed,
				};
			}
		}
	}

	const comments = await createNavigationCommentStore(github).reconcile({
		repo: plan.repository,
		defaultBranch: plan.defaultBranch,
		published: published.map((slice) => ({ ...slice, ref: slice.bookmark })),
		cwd: options.cwd,
		signal: deps.signal,
	});
	const pullRequests = provenPullRequests(published);
	if (comments.indeterminate) {
		return {
			status: "indeterminate",
			planId: plan.planId,
			inFlight: comments.indeterminate,
			completedActions: [...completed, ...comments.completed],
			recovery: "Core publication may have succeeded; re-run /jj-stack plan before retrying comments.",
		};
	}
	if (pullRequests.length !== plan.slices.length) {
		return {
			status: "partial",
			planId: plan.planId,
			completedActions: [...completed, ...comments.completed],
			failedAction: { kind: "create-draft-pr", error: "A created PR could not be proven by a fresh identity." },
			commentErrors: comments.errors,
		};
	}
	return {
		status: "completed",
		planId: plan.planId,
		publication: {
			repository: plan.repository,
			remote: plan.remote.name,
			topRef: plan.slices[plan.slices.length - 1].bookmark,
			pullRequests,
		},
		completedActions: [...completed, ...comments.completed],
		...(comments.errors.length > 0 ? { commentErrors: comments.errors } : undefined),
	};
}

async function snapshotPublication(
	model: InspectModel,
	options: PlanOptions,
	deps: OrchestratorDeps,
): Promise<{ snapshot: PublicationSnapshot } | { blockers: StackBlocker[] }> {
	if (!model.top)
		return {
			blockers: [{ code: "missing-top", message: "No top bookmark could be inferred. Specify --top explicitly." }],
		};
	const derived = slicesForPublication(model.stack, model.top);
	if ("blocker" in derived) return { blockers: [derived.blocker] };
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const github = deps.github ?? createJjGitHubGateway(deps.run);
	const remote = await jj.getRemote(options.cwd, options.remote, deps.signal);
	if (!remote.github) {
		return {
			blockers: [
				{
					code: "non-github-remote",
					message: `Remote ${JSON.stringify(options.remote)} is not a GitHub repository: ${remote.redactedUrl}`,
				},
			],
		};
	}
	const defaultBranch = await github.getDefaultBranch(remote.github, options.cwd, deps.signal);
	const openPrs = await github.listOpenPrs(remote.github, options.cwd, deps.signal);
	const localBookmarks = await jj.listLocalBookmarks(options.cwd, deps.signal);
	const remoteBookmarks = await jj.listRemoteBookmarks(options.cwd, options.remote, deps.signal);
	return {
		snapshot: {
			changeCount: model.stack.length,
			repository: remote.github,
			remote,
			defaultBranch,
			slices: derived.slices,
			localBookmarks,
			remoteBookmarks,
			openPrs,
		},
	};
}

function publicationBlockers(model: InspectModel): StackBlocker[] {
	const blockers = [...model.blockers];
	if (model.truncated && !blockers.some((blocker) => blocker.code === "truncated")) {
		blockers.push({ code: "truncated", message: "The stack is truncated; publish refused on incomplete data." });
	}
	if (!model.top)
		blockers.push({ code: "missing-top", message: "No top bookmark could be inferred. Specify --top explicitly." });
	return blockers;
}

function markWorkingCopy(commits: readonly StackCommit[], wcChange: string | undefined): StackCommit[] {
	return commits.map((commit) => ({ ...commit, workingCopy: commit.changeId === wcChange }));
}

function slicesOrEmpty(stack: readonly StackCommit[], top: string) {
	const derived = slicesForPublication(stack, top);
	return "slices" in derived ? derived.slices : [];
}

function inspectFailure(
	jjVersion: string,
	trunkRevset: string,
	trunkCommit: string,
	localBookmarks: { name: string }[],
	maxStack: number,
	blockers: StackBlocker[],
): InspectModel {
	return {
		schemaVersion: SCHEMA_VERSION,
		jjVersion,
		trunk: { revset: trunkRevset, commitId: trunkCommit },
		top: undefined,
		topCommitId: undefined,
		localBookmarks: localBookmarks.map((bookmark) => bookmark.name).sort(),
		stack: [],
		slices: [],
		truncated: false,
		maxStack,
		blockers,
	};
}

function provenPullRequests(
	published: Array<{
		bookmark: string;
		baseBookmark: string | null;
		changeIds: readonly string[];
		prNumber: number | undefined;
		url?: string;
		draft: boolean;
	}>,
): StackPublishedPullRequest[] {
	const prs: StackPublishedPullRequest[] = [];
	for (const slice of published) {
		if (slice.prNumber === undefined || !slice.url) return prs;
		prs.push({
			ref: slice.bookmark,
			baseRef: slice.baseBookmark,
			changeIds: slice.changeIds,
			prNumber: slice.prNumber,
			url: slice.url,
			draft: slice.draft,
		});
	}
	return prs;
}

function toFailedAction(
	kind: FailedPublicationAction["kind"],
	error: BoundaryValue,
	bookmark: string,
): FailedPublicationAction {
	return { kind, ref: bookmark, error: errorMessage(error) };
}

function provisionalPrMetadata(
	subject: string,
	bookmark: string,
	repositoryTemplate?: RepositoryPrTemplate,
): PrMetadata {
	const document: PrDocument = {
		title: subject || bookmark,
		summaryBullets: [subject || bookmark],
		reviewSteps: [
			{
				label: "Slice behavior",
				description: `Review the exact changes published by \`${bookmark}\`.`,
			},
		],
	};
	return repositoryTemplate ? renderRepositoryPrTemplate(document, repositoryTemplate) : renderPrDocument(document);
}

function isIndeterminate(error: BoundaryValue): boolean {
	return (error instanceof JjError || error instanceof GitHubError) && error.kind === "indeterminate";
}

function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}

function mutationFailure(
	error: BoundaryValue,
	signal: AbortSignal | undefined,
	operationId: string,
	label: string,
	mutationCompleted: boolean,
): Extract<SyncOutcome, { status: "partial" | "indeterminate" | "failed" }> {
	if (isIndeterminate(error) || signal?.aborted) {
		return { status: "indeterminate", operationId, inFlight: `${label}: ${errorMessage(error)}` };
	}
	if (mutationCompleted) return { status: "partial", operationId, blockers: [], error: errorMessage(error) };
	return { status: "failed", error: errorMessage(error), operationId };
}

function canonicalize(path: string, realpath?: (value: string) => string): string {
	try {
		return (realpath ?? realpathSync)(path);
	} catch {
		return path;
	}
}
