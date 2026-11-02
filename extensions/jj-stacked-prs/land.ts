import type { BoundaryValue } from "../shared/validation.ts";

/** Native stack landing and verified single-PR settlement. */

import { applyDelegatedFrontierSettlement } from "../land/api.ts";
import { type GitHubGateway, isMergeMethod } from "../shared/github.ts";
import {
	emptyStackLandProgress,
	type StackLandFrontier,
	type StackLandOutcome,
	type StackPrefixLandOutcome,
} from "../shared/stack/outcome.ts";
import { planIdFor } from "../shared/stack/plan-id.ts";
import { createNavigationCommentStore } from "../shared/stack/topology.ts";
import { missingUiBlocker, runLanding, type StackTransactionPhase } from "../shared/stack/transaction.ts";
import { errorMessage, isIndeterminate } from "./errors.ts";
import { createJjGitHubGateway, execFromRunner } from "./github-gateway.ts";
import { createJjAdapter } from "./jj.ts";
import { runNativeLand } from "./native-land.ts";
import { createNativeStackGateway, type NativeStack, NativeStackError, samePrNumbers } from "./native-stack.ts";
import { applyAdvance, inspectStack, type OrchestratorDeps, type ResolvedOrchestratorDeps } from "./orchestrator.ts";
import { renderStackLandingPlan } from "./render.ts";
import type { InspectModel, StackBlocker, StackMergeMethod, StackReadinessMode } from "./types.ts";
import { identifyWorkingCopyToSettle, settleWorkingCopyOnTrunk } from "./working-copy-settlement.ts";

interface LandStackOptions {
	cwd: string;
	top: string;
	remote: string;
	trunk?: string;
	maxStack?: number;
	method?: StackMergeMethod;
	readiness: StackReadinessMode;
}

interface MappedLandSlice {
	bookmark: string;
	prNumber: number;
	url: string;
	headCommitId: string;
	baseRef: string;
	draft: boolean;
	alreadyMerged: boolean;
}

export async function landStackThroughPullRequest(
	options: {
		cwd: string;
		prNumber: number;
		headBookmark: string;
		readiness: StackReadinessMode;
		method?: StackMergeMethod;
	},
	deps: OrchestratorDeps,
): Promise<StackPrefixLandOutcome> {
	// Discovery below reads jj and GitHub; refuse a request that cannot be confirmed before spending that work.
	const missingUi = missingUiBlocker("interactive-confirmation", deps.ui.hasUI, "Stack landing");
	if (missingUi) return { status: "stack", outcome: { status: "blocked", blockers: [missingUi] } };
	const resolvedDeps = resolveLandingDeps(deps);
	const jj = resolvedDeps.jj;
	const github = resolvedDeps.github;
	const localBookmarks = await jj.listLocalBookmarks(options.cwd, deps.signal);
	const hasLocalHead = localBookmarks.some((bookmark) => bookmark.name === options.headBookmark);
	const model = hasLocalHead
		? await inspectStack({ cwd: options.cwd, top: options.headBookmark }, resolvedDeps)
		: undefined;
	if (model && model.slices.length > 1 && model.blockers.length > 0) {
		return { status: "stack", outcome: { status: "blocked", blockers: model.blockers } };
	}

	const candidates: Array<{ remote: string; repository: { owner: string; repo: string } }> = [];
	for (const remote of await jj.listRemotes(options.cwd, deps.signal)) {
		if (!remote.github) continue;
		const prs = await github.listOpenPrs(remote.github, options.cwd, deps.signal);
		if (prs.some((pr) => pr.number === options.prNumber && pr.headRef === options.headBookmark)) {
			candidates.push({ remote: remote.name, repository: remote.github });
		}
	}
	if (candidates.length !== 1) {
		const message =
			candidates.length === 0
				? `Could not map PR #${options.prNumber} and bookmark ${JSON.stringify(options.headBookmark)} to a GitHub remote.`
				: `PR #${options.prNumber} and bookmark ${JSON.stringify(options.headBookmark)} match multiple GitHub remotes.`;
		return {
			status: "stack",
			outcome: {
				status: "blocked",
				blockers: [{ code: candidates.length === 0 ? "missing-remote" : "ambiguous-remote", message }],
			},
		};
	}

	const candidate = candidates[0];
	let metadataConfirmsPrefix = false;
	if (!model || model.slices.length <= 1) {
		const native = resolvedDeps.nativeStack;
		let nativeMembership: NativeStack | undefined;
		try {
			nativeMembership = await native.inspectForPullRequest({
				cwd: options.cwd,
				repo: candidate.repository,
				prNumber: options.prNumber,
				signal: deps.signal,
			});
		} catch (error) {
			return { status: "stack", outcome: classifyNativePreparationError(error) };
		}
		if (nativeMembership) {
			metadataConfirmsPrefix = nativeMembership.pullRequests.length > 1;
		} else {
			const membership = await createNavigationCommentStore(github).membership({
				repo: candidate.repository,
				prNumber: options.prNumber,
				headRef: options.headBookmark,
				cwd: options.cwd,
				signal: deps.signal,
			});
			metadataConfirmsPrefix = membership.selectedIndex > 0;
		}
	}

	if (!model) {
		if (!metadataConfirmsPrefix) return { status: "not-stack" };
		return {
			status: "stack",
			outcome: {
				status: "blocked",
				blockers: [
					{
						code: "ambiguous-local-bookmark",
						ref: options.headBookmark,
						message: `PR #${options.prNumber} belongs to a kstack prefix, but its head bookmark is not available locally.`,
					},
				],
			},
		};
	}
	if (model.blockers.length > 0) return { status: "stack", outcome: { status: "blocked", blockers: model.blockers } };
	if (model.slices.length <= 1 && metadataConfirmsPrefix) {
		return {
			status: "stack",
			outcome: {
				status: "blocked",
				blockers: [
					{
						code: "not-rooted-at-trunk",
						message: `PR #${options.prNumber} belongs to a stack whose predecessors or descendants are missing from the selected local stack.`,
					},
				],
			},
		};
	}

	const outcome = await landStackWithAuthorization(
		{
			cwd: options.cwd,
			top: options.headBookmark,
			remote: candidate.remote,
			method: options.method,
			readiness: options.readiness,
		},
		resolvedDeps,
		"interactive-confirmation",
		model,
	);
	return { status: "stack", outcome };
}

export async function landStack(options: LandStackOptions, deps: OrchestratorDeps): Promise<StackLandOutcome> {
	return landStackWithAuthorization(options, resolveLandingDeps(deps), "interactive-confirmation");
}

/** Land after an explicit model tool call, without a second UI confirmation. */
export async function landStackFromTool(options: LandStackOptions, deps: OrchestratorDeps): Promise<StackLandOutcome> {
	return landStackWithAuthorization(options, resolveLandingDeps(deps), "model-tool");
}

function classifyNativePreparationError(error: BoundaryValue): StackLandOutcome {
	if (error instanceof NativeStackError && error.kind === "indeterminate") {
		return {
			status: "indeterminate",
			inFlight: error.message,
			recovery: "Retry native stack inspection before landing; no merge was submitted.",
			...emptyStackLandProgress(),
		};
	}
	if (error instanceof NativeStackError && error.kind === "unavailable") {
		return { status: "blocked", blockers: [{ code: "native-stack-unavailable", message: error.message }] };
	}
	return { status: "failed", error: errorMessage(error), ...emptyStackLandProgress() };
}

function resolveLandingDeps(deps: OrchestratorDeps): ResolvedOrchestratorDeps {
	return {
		...deps,
		jj: deps.jj ?? createJjAdapter(deps.run),
		github: deps.github ?? createJjGitHubGateway(deps.run),
		nativeStack: deps.nativeStack ?? createNativeStackGateway(deps.run),
	};
}

const LANDING_STATUS = {
	planning: "jj-stack: planning landing",
	confirming: "jj-stack: confirm landing",
	locking: "jj-stack: waiting for the repository lock",
	replanning: "jj-stack: re-checking the landing plan",
	applying: "jj-stack: landing",
} satisfies Record<StackTransactionPhase, string>;

type PreparedLand = Extract<Awaited<ReturnType<typeof prepareLand>>, { status: "ok" }>;

/**
 * Both landing shapes run under the repository lock. The single-PR path merges a PR and rewrites local history,
 * which is exactly what the lock serializes. `apply` may ask PR Autopilot to land a frontier while holding the
 * lock because jj's mutation backend never takes that lock.
 */
async function landStackWithAuthorization(
	options: LandStackOptions,
	deps: ResolvedOrchestratorDeps,
	authorization: "interactive-confirmation" | "model-tool",
	initialModel?: InspectModel,
): Promise<StackLandOutcome> {
	// The first plan reuses the caller's inspection and may ask for a merge method. The locked re-plan inspects
	// again but keeps the chosen method, so the user is asked once.
	let model = initialModel;
	let method = options.method;
	let applying = false;
	const injectedAcquireLock = deps.acquirePublicationLock;
	try {
		return await runLanding(
			{
				async plan() {
					const prepared = await prepareLand({ ...options, method }, deps, model);
					model = undefined;
					if (prepared.status !== "ok") return { ok: false, blockers: prepared.blockers };
					method = prepared.method;
					const confirmation = renderStackLandingPlan({
						changeCount: prepared.model.stack.length,
						slices: prepared.mapped,
						method: prepared.method,
						readiness: options.readiness,
						nativeStackNumber: prepared.kind === "native" ? prepared.nativeStack.stackNumber : undefined,
						queuePolicy: prepared.queuePolicy,
					});
					// Only a human reads the preview; an over-long one blocks interactive landing alone.
					if (!confirmation.ok && authorization === "interactive-confirmation") {
						return { ok: false, blockers: [{ code: "truncated", message: confirmation.reason }] };
					}
					const preview = confirmation.ok ? confirmation.body : confirmation.reason;
					return { ok: true, plan: { planId: landingPlanId(options, prepared), preview, prepared } };
				},
				apply({ prepared }) {
					applying = true;
					if (prepared.kind === "single") return runSingleLand(options, deps, prepared);
					return runNativeLand(
						options,
						deps,
						prepared.method,
						prepared.model,
						prepared.mapped,
						prepared.nativeStack,
						prepared.repository,
						deps.nativeStack,
					);
				},
			},
			{
				authorization,
				ui: deps.ui,
				confirmTitle: "Land this stacked PR plan?",
				lock: {
					exec: execFromRunner(deps.run),
					cwd: options.cwd,
					backend: "jj",
					acquireLock: injectedAcquireLock ? ({ repositoryPath }) => injectedAcquireLock(repositoryPath) : undefined,
					realpath: deps.realpath,
				},
				onPhase: (phase) => deps.ui.setStatus(LANDING_STATUS[phase]),
				signal: deps.signal,
			},
		);
	} catch (error) {
		// Apply owns its errors; a planning error (for example native stack inspection) means nothing was submitted.
		if (applying) throw error;
		return classifyNativePreparationError(error);
	}
}

/** Every fact the landing depends on, so a re-plan under the lock proves the confirmed plan is still current. */
function landingPlanId(options: LandStackOptions, prepared: PreparedLand): string {
	const nativeStack =
		prepared.kind === "native"
			? {
					stackNumber: prepared.nativeStack.stackNumber,
					baseRef: prepared.nativeStack.baseRef,
					baseSha: prepared.nativeStack.baseSha ?? null,
					open: prepared.nativeStack.open,
					pullRequests: prepared.nativeStack.pullRequests.map((pr) => ({
						number: pr.number,
						state: pr.state,
						draft: pr.draft,
						mergedAt: pr.mergedAt ?? null,
						head: { ref: pr.head.ref, sha: pr.head.sha },
					})),
				}
			: null;
	return planIdFor(1, {
		remote: options.remote,
		trunkRevset: options.trunk ?? "trunk()",
		readiness: options.readiness,
		kind: prepared.kind,
		method: prepared.method,
		queuePolicy: prepared.queuePolicy,
		repository: { owner: prepared.repository.owner, repo: prepared.repository.repo },
		trunkCommitId: prepared.model.trunk.commitId,
		stack: prepared.model.stack.map((commit) => ({
			changeId: commit.changeId,
			commitId: commit.commitId,
			bookmarks: [...commit.bookmarks],
		})),
		slices: prepared.mapped.map((slice) => ({ ...slice })),
		nativeStack,
	});
}

async function remapLand(
	options: LandStackOptions,
	deps: OrchestratorDeps,
	inspectedModel?: InspectModel,
): Promise<
	| { status: "ok"; mapped: MappedLandSlice[]; model: InspectModel; repository: { owner: string; repo: string } }
	| { status: "blocked"; blockers: StackBlocker[] }
> {
	const model = inspectedModel ?? (await inspectStack(options, deps));
	const mapped = await mapStackPullRequests(model, options, deps);
	if (mapped.status !== "ok") return mapped;
	return { status: "ok", mapped: mapped.mapped, model, repository: mapped.repository };
}

async function prepareLand(
	options: LandStackOptions,
	deps: ResolvedOrchestratorDeps,
	initialModel?: InspectModel,
): Promise<
	| ({
			status: "ok";
			mapped: MappedLandSlice[];
			method: StackMergeMethod;
			model: InspectModel;
			repository: { owner: string; repo: string };
			queuePolicy: boolean;
	  } & ({ kind: "single" } | { kind: "native"; nativeStack: NativeStack }))
	| { status: "blocked"; blockers: StackBlocker[] }
> {
	const remapped = await remapLand(options, deps, initialModel);
	if (remapped.status !== "ok") return remapped;
	const method = await resolveLandMethod(
		options,
		deps,
		remapped.repository,
		deps.github ?? createJjGitHubGateway(deps.run),
	);
	if (method.status !== "ok") return method;
	const native = deps.nativeStack;
	if (remapped.mapped.length === 1) {
		return {
			status: "ok",
			kind: "single",
			mapped: remapped.mapped,
			method: method.method,
			model: remapped.model,
			repository: remapped.repository,
			queuePolicy: false,
		};
	}
	const top = remapped.mapped[remapped.mapped.length - 1];
	const nativeStack = await native.inspectForPullRequest({
		cwd: options.cwd,
		repo: remapped.repository,
		prNumber: top.prNumber,
		signal: deps.signal,
	});
	if (!nativeStack) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "native-stack-unavailable",
					message: "This multi-PR stack is not linked as a GitHub-native stack. Publish it before landing.",
				},
			],
		};
	}
	const queuePolicy = await native.baseUsesMergeQueue({
		cwd: options.cwd,
		repo: remapped.repository,
		base: nativeStack.baseRef,
		signal: deps.signal,
	});
	if (queuePolicy && !deps.configuredMethodFor?.(`${remapped.repository.owner}/${remapped.repository.repo}`)) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "land-unavailable",
					message:
						'This branch uses a merge queue. Configure land.repos["owner/repo"] as an explicit squash or rebase queue-policy assertion before landing.',
				},
			],
		};
	}
	const expected = remapped.mapped.map((slice) => slice.prNumber);
	const actual = nativeStack.pullRequests.map((pr) => pr.number);
	if (!samePrNumbers(expected, actual)) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "native-stack-diverged",
					message: `Native stack #${nativeStack.stackNumber} contains ${actual.join(", ")}; full-stack landing requires selecting its top PR and matching the complete local stack.`,
				},
			],
		};
	}
	return {
		status: "ok",
		kind: "native",
		mapped: remapped.mapped,
		method: method.method,
		model: remapped.model,
		repository: remapped.repository,
		nativeStack,
		queuePolicy,
	};
}

async function mapStackPullRequests(
	model: InspectModel,
	options: LandStackOptions,
	deps: OrchestratorDeps,
): Promise<
	| { status: "ok"; mapped: MappedLandSlice[]; repository: { owner: string; repo: string } }
	| { status: "blocked"; blockers: StackBlocker[] }
> {
	if (model.blockers.length > 0) return { status: "blocked", blockers: [...model.blockers] };
	if (!model.top || model.slices.length === 0) {
		return {
			status: "blocked",
			blockers: [{ code: "empty-stack", message: "No stacked PR slices are available to land." }],
		};
	}
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const github = deps.github ?? createJjGitHubGateway(deps.run);
	const remote = await jj.getRemote(options.cwd, options.remote, deps.signal);
	if (!remote.github) {
		return {
			status: "blocked",
			blockers: [{ code: "non-github-remote", message: `Remote ${options.remote} is not a GitHub repository.` }],
		};
	}
	const defaultBranch = await github.getDefaultBranch(remote.github, options.cwd, deps.signal);
	const openPrs = await github.listOpenPrs(remote.github, options.cwd, deps.signal);
	const mapped: MappedLandSlice[] = [];
	for (const [index, slice] of model.slices.entries()) {
		const local = model.stack.find((commit) => commit.bookmarks.includes(slice.bookmark));
		if (!local) {
			return {
				status: "blocked",
				blockers: [
					{
						code: "ambiguous-local-bookmark",
						message: `Bookmark ${JSON.stringify(slice.bookmark)} is not present on the inspected stack.`,
						ref: slice.bookmark,
					},
				],
			};
		}
		const opens = openPrs.filter((pr) => pr.headRef === slice.bookmark);
		if (opens.length > 1) {
			return {
				status: "blocked",
				blockers: [
					{
						code: "ambiguous-pr",
						message: `Multiple open PRs use bookmark ${JSON.stringify(slice.bookmark)}.`,
						ref: slice.bookmark,
					},
				],
			};
		}
		if (opens.length === 1) {
			const pr = opens[0];
			if (pr.headCommitId !== local.commitId) {
				return {
					status: "blocked",
					blockers: [
						{
							code: "head-mismatch",
							message: `PR #${pr.number} head ${pr.headCommitId} does not match local bookmark ${JSON.stringify(slice.bookmark)} at ${local.commitId}.`,
							ref: slice.bookmark,
						},
					],
				};
			}
			const expectedBase = index === 0 ? defaultBranch : model.slices[index - 1].bookmark;
			if (pr.baseRef !== expectedBase) {
				return {
					status: "blocked",
					blockers: [
						{
							code: "base-chain-mismatch",
							message: `PR #${pr.number} base ${JSON.stringify(pr.baseRef)} is not ${JSON.stringify(expectedBase)}.`,
							ref: slice.bookmark,
						},
					],
				};
			}
			mapped.push({
				bookmark: slice.bookmark,
				prNumber: pr.number,
				url: pr.url,
				headCommitId: pr.headCommitId,
				baseRef: pr.baseRef,
				draft: pr.draft,
				alreadyMerged: false,
			});
			continue;
		}
		const all = await github.listPrsForHead(remote.github, slice.bookmark, options.cwd, deps.signal);
		const pr = all[0];
		if (!pr) {
			return {
				status: "blocked",
				blockers: [
					{
						code: "publish-required",
						message: `No pull request exists for bookmark ${JSON.stringify(slice.bookmark)}. Publish the stack before landing.`,
						ref: slice.bookmark,
					},
				],
			};
		}
		if (all.length > 1) {
			return {
				status: "blocked",
				blockers: [
					{
						code: "ambiguous-pr-history",
						message: `Multiple pull requests in repository history use bookmark ${JSON.stringify(slice.bookmark)}.`,
						ref: slice.bookmark,
					},
				],
			};
		}
		const status = await github.getPrStatus(remote.github, pr.number, options.cwd, deps.signal);
		if (status === "merged" && index === 0 && pr.headCommitId === local.commitId) {
			mapped.push({
				bookmark: slice.bookmark,
				prNumber: pr.number,
				url: pr.url,
				headCommitId: pr.headCommitId,
				baseRef: pr.baseRef,
				draft: false,
				alreadyMerged: true,
			});
			continue;
		}
		if (status === "merged") {
			return {
				status: "blocked",
				blockers: [
					{
						code: "out-of-order-merge",
						message: `PR #${pr.number} for ${JSON.stringify(slice.bookmark)} is merged before its stack predecessors.`,
						ref: slice.bookmark,
					},
				],
			};
		}
		return {
			status: "blocked",
			blockers: [
				{
					code: "ambiguous-pr",
					message: `Could not resolve an open or already-merged PR for bookmark ${JSON.stringify(slice.bookmark)}.`,
					ref: slice.bookmark,
				},
			],
		};
	}
	return { status: "ok", mapped, repository: remote.github };
}

async function resolveLandMethod(
	options: LandStackOptions,
	deps: OrchestratorDeps,
	repository: { owner: string; repo: string },
	github: GitHubGateway,
): Promise<{ status: "ok"; method: StackMergeMethod } | { status: "blocked"; blockers: StackBlocker[] }> {
	const allowed = await github.getAllowedMergeMethods(repository, options.cwd, deps.signal);
	if (allowed.length === 0) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "land-unavailable",
					message:
						"Repository only allows merge commits; kstack does not support merge commits. Enable squash or rebase merging in repository settings.",
				},
			],
		};
	}
	const configured = deps.configuredMethodFor?.(`${repository.owner}/${repository.repo}`);
	const selected = options.method ?? configured;
	if (selected) {
		if (!allowed.includes(selected)) {
			return {
				status: "blocked",
				blockers: [
					{
						code: "land-unavailable",
						message: `Merge method ${selected} is not enabled for ${repository.owner}/${repository.repo}.`,
					},
				],
			};
		}
		return { status: "ok", method: selected };
	}
	if (deps.ui.hasUI) {
		const picked = await deps.ui.select("Select an allowed merge method", allowed);
		if (isMergeMethod(picked)) return { status: "ok", method: picked };
		return {
			status: "blocked",
			blockers: [{ code: "land-unavailable", message: "No merge method selected." }],
		};
	}
	if (allowed.length === 1) return { status: "ok", method: allowed[0] };
	return {
		status: "blocked",
		blockers: [
			{
				code: "land-unavailable",
				message: "Stack landing needs --method squash|rebase when more than one method is enabled.",
			},
		],
	};
}

async function runSingleLand(
	options: LandStackOptions,
	deps: ResolvedOrchestratorDeps,
	prepared: Extract<PreparedLand, { kind: "single" }>,
): Promise<StackLandOutcome> {
	const { jj, github, landFrontier } = deps;
	const { method } = prepared;
	const frontiers: StackLandFrontier[] = [];
	const completedMutations: string[] = [];
	const warnings: string[] = [];
	const recoveryOperationIds: string[] = [];
	const current = prepared.mapped[0];
	let remainingRefs = [current.bookmark];
	const settlement = await identifyWorkingCopyToSettle(options, deps, jj, prepared.model, warnings);

	const progress = () => ({
		frontiers: [...frontiers],
		remainingRefs,
		completedMutations: [...completedMutations],
		warnings: [...warnings],
		recoveryOperationIds: [...recoveryOperationIds],
	});

	if (deps.signal?.aborted) return { status: "cancelled", ...progress() };
	let frontier: StackLandFrontier = {
		ref: current.bookmark,
		prNumber: current.prNumber,
		url: current.url,
		expectedHeadSha: current.headCommitId,
		method,
		state: "not-attempted",
	};
	deps.ui.setStatus(`jj-stack: landing #${current.prNumber}`);

	if (current.alreadyMerged) {
		frontier.state = "already-merged";
		completedMutations.push(`PR #${current.prNumber} already merged; advancing`);
	} else {
		const landed = landFrontier
			? await landFrontier({
					repository: `${prepared.repository.owner}/${prepared.repository.repo}`,
					prNumber: current.prNumber,
					expectedHeadSha: current.headCommitId,
					expectedBaseRef: current.baseRef,
					readiness: options.readiness,
					method,
				})
			: { handled: false as const };
		const settlement = applyDelegatedFrontierSettlement({
			response: landed,
			frontier,
			progress: { frontiers, remainingRefs, completedMutations, warnings, recoveryOperationIds },
		});
		if (settlement.kind === "halted") return settlement.outcome;
		frontier = settlement.frontier;
		completedMutations.push(...settlement.newCompletedMutations);
	}

	const remote = await jj.getRemote(options.cwd, options.remote, deps.signal);
	if (!remote.github) {
		frontiers.push(frontier);
		return { status: "partial", error: `Remote ${options.remote} is not a GitHub repository.`, ...progress() };
	}
	let mergeCommitOid: string;
	try {
		const merge = await github.getMergeCommit(remote.github, current.prNumber, options.cwd, deps.signal);
		if (!merge.merged || !merge.mergeCommitOid) {
			frontiers.push({ ...frontier, state: frontier.state === "landed" ? "queued" : frontier.state });
			return {
				status: "partial",
				error: `PR #${current.prNumber} is not verified merged with a merge commit on GitHub.`,
				...progress(),
			};
		}
		if (merge.headCommitId !== frontier.expectedHeadSha || merge.headRef !== current.bookmark) {
			frontiers.push(frontier);
			return {
				status: "partial",
				error: `PR #${current.prNumber} merged head ${merge.headCommitId} (${merge.headRef}) does not match pinned head ${frontier.expectedHeadSha} (${current.bookmark}).`,
				...progress(),
			};
		}
		mergeCommitOid = merge.mergeCommitOid;
	} catch (error) {
		frontiers.push({ ...frontier, state: frontier.state === "landed" ? "queued" : frontier.state });
		return isIndeterminate(error)
			? {
					status: "indeterminate",
					inFlight: `merge-verification: ${errorMessage(error)}`,
					recovery: "Inspect the frontier PR and remote stack state before retrying.",
					...progress(),
				}
			: { status: "partial", error: errorMessage(error), ...progress() };
	}

	const operationId = await jj.currentOperationId(options.cwd, deps.signal);
	const advanced = await applyAdvance({ ...options, merged: current.bookmark }, deps, {
		jj,
		operationId,
		trunkCommitId: prepared.model.trunk.commitId,
		trunkRevset: options.trunk ?? "trunk()",
	});
	recoveryOperationIds.push(operationId);
	if (advanced.status !== "completed") {
		frontiers.push(frontier);
		if (advanced.status === "indeterminate") {
			return {
				status: "indeterminate",
				inFlight: advanced.inFlight,
				recovery: `jj op restore ${operationId}`,
				...progress(),
			};
		}
		const error =
			advanced.status === "partial" || advanced.status === "failed"
				? advanced.error
				: `Advance returned ${advanced.status}.`;
		return { status: "partial", error, ...progress() };
	}

	let refreshedTrunkCommitId: string | undefined;
	try {
		const trunk = await jj.resolveRevset(options.cwd, options.trunk ?? "trunk()", deps.signal);
		const onTrunk = await jj.isAncestor(options.cwd, mergeCommitOid, trunk, deps.signal);
		if (!onTrunk) {
			frontiers.push(frontier);
			remainingRefs = [];
			return {
				status: "partial",
				error: `Merge commit ${mergeCommitOid} for PR #${current.prNumber} is not an ancestor of the refreshed trunk.`,
				...progress(),
			};
		}
		refreshedTrunkCommitId = trunk;
	} catch (error) {
		frontiers.push(frontier);
		if (isIndeterminate(error)) {
			return {
				status: "indeterminate",
				inFlight: `trunk-verify: ${errorMessage(error)}`,
				recovery: `jj op restore ${operationId}`,
				...progress(),
			};
		}
		return { status: "partial", error: errorMessage(error), ...progress() };
	}

	try {
		const deleted = await github.deleteRemoteBranch({
			repo: remote.github,
			branch: current.bookmark,
			expectedHeadSha: frontier.expectedHeadSha,
			cwd: options.cwd,
			signal: deps.signal,
		});
		if (deleted.kind === "deleted") {
			completedMutations.push(`Deleted remote branch ${current.bookmark}`);
		} else if (deleted.kind === "already-gone") {
			completedMutations.push(`Remote branch ${current.bookmark} already deleted`);
		} else if (deleted.kind === "changed") {
			warnings.push(
				`Skipped deleting ${current.bookmark}: remote SHA ${deleted.actualHeadSha} does not match landed head ${frontier.expectedHeadSha}`,
			);
		}
	} catch (error) {
		warnings.push(`Failed to delete remote branch ${current.bookmark}: ${errorMessage(error)}`);
	}

	frontiers.push(frontier);
	remainingRefs = [];
	await settleWorkingCopyOnTrunk(options, deps, jj, settlement, refreshedTrunkCommitId, completedMutations, warnings);
	return { status: "completed", ...progress() };
}
