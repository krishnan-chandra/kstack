/** Stack landing loop: preflight, land, advance, verify, republish. */

import { isMergeMethod } from "../shared/github.ts";
import {
	createGitHubAdapter,
	findKstackComment,
	type GitHubAdapter,
	GitHubError,
	parseNavigationCommentEntries,
} from "./github.ts";
import { createJjAdapter, type JjAdapter, JjError } from "./jj.ts";
import { applyAdvance, inspectStack, type OrchestratorDeps, publishStackFromTool } from "./orchestrator.ts";
import { renderLandConfirmation } from "./render.ts";
import type {
	InspectModel,
	StackBlocker,
	StackLandFrontier,
	StackLandOutcome,
	StackMergeMethod,
	StackPrefixLandOutcome,
	StackReadinessMode,
} from "./types.ts";

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
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const github = deps.github ?? createGitHubAdapter(deps.run);
	const localBookmarks = await jj.listLocalBookmarks(options.cwd, deps.signal);
	const hasLocalHead = localBookmarks.some((bookmark) => bookmark.name === options.headBookmark);
	const model = hasLocalHead ? await inspectStack({ cwd: options.cwd, top: options.headBookmark }, deps) : undefined;
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
		const user = await github.getAuthenticatedUser(options.cwd, deps.signal);
		const comments = await github.getPrComments(candidate.repository, options.prNumber, options.cwd, deps.signal);
		const navigation = findKstackComment(comments, user);
		const entries = navigation ? parseNavigationCommentEntries(navigation.body) : [];
		const selectedIndex = entries.findIndex(
			(entry) => entry.prNumber === options.prNumber && entry.bookmark === options.headBookmark,
		);
		metadataConfirmsPrefix = selectedIndex > 0;
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
						bookmark: options.headBookmark,
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
						message: `PR #${options.prNumber} has kstack predecessors that are missing from the local stack.`,
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
		deps,
		"interactive-confirmation",
		model,
	);
	return { status: "stack", outcome };
}

export async function landStack(options: LandStackOptions, deps: OrchestratorDeps): Promise<StackLandOutcome> {
	return landStackWithAuthorization(options, deps, "interactive-confirmation");
}

/** Land after an explicit model tool call, without a second UI confirmation. */
export async function landStackFromTool(options: LandStackOptions, deps: OrchestratorDeps): Promise<StackLandOutcome> {
	return landStackWithAuthorization(options, deps, "model-tool");
}

async function landStackWithAuthorization(
	options: LandStackOptions,
	deps: OrchestratorDeps,
	authorization: "interactive-confirmation" | "model-tool",
	initialModel?: InspectModel,
): Promise<StackLandOutcome> {
	if (authorization === "interactive-confirmation" && !deps.ui.hasUI) {
		return {
			status: "blocked",
			blockers: [{ code: "missing-remote", message: "Stack landing requires interactive TUI/RPC mode." }],
		};
	}
	if (!deps.landPr) {
		return {
			status: "blocked",
			blockers: [
				{
					code: "land-unavailable",
					message: "The land extension is unavailable. Load land before /jj-stack land.",
				},
			],
		};
	}
	if (deps.signal?.aborted) return { status: "cancelled" };
	const prepared = await prepareLand(options, deps, initialModel);
	if (prepared.status !== "ok") return prepared;
	if (authorization === "interactive-confirmation") {
		const confirmation = renderLandConfirmation({
			changeCount: prepared.model.stack.length,
			slices: prepared.mapped,
			method: prepared.method,
			readiness: options.readiness,
		});
		if (!confirmation.ok) {
			return { status: "blocked", blockers: [{ code: "truncated", message: confirmation.reason }] };
		}
		deps.ui.setStatus("jj-stack: confirm landing");
		const confirmed = await deps.ui.confirm("Land this stacked PR plan?", confirmation.body);
		if (deps.signal?.aborted) return { status: "cancelled" };
		if (!confirmed) return { status: "declined" };
	}
	return runLandLoop(options, deps, prepared.method, prepared.model, prepared.mapped);
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
	deps: OrchestratorDeps,
	initialModel?: InspectModel,
): Promise<
	| { status: "ok"; mapped: MappedLandSlice[]; method: StackMergeMethod; model: InspectModel }
	| { status: "blocked"; blockers: StackBlocker[] }
> {
	const remapped = await remapLand(options, deps, initialModel);
	if (remapped.status !== "ok") return remapped;
	const method = await resolveLandMethod(
		options,
		deps,
		remapped.repository,
		deps.github ?? createGitHubAdapter(deps.run),
	);
	if (method.status !== "ok") return method;
	return { status: "ok", mapped: remapped.mapped, method: method.method, model: remapped.model };
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
	const github = deps.github ?? createGitHubAdapter(deps.run);
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
						bookmark: slice.bookmark,
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
						bookmark: slice.bookmark,
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
							bookmark: slice.bookmark,
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
							bookmark: slice.bookmark,
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
						bookmark: slice.bookmark,
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
						bookmark: slice.bookmark,
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
						bookmark: slice.bookmark,
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
					bookmark: slice.bookmark,
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
	github: GitHubAdapter,
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

async function runLandLoop(
	options: LandStackOptions,
	deps: OrchestratorDeps,
	method: StackMergeMethod,
	initialModel: InspectModel,
	initialMapped: MappedLandSlice[],
): Promise<StackLandOutcome> {
	const jj = deps.jj ?? createJjAdapter(deps.run);
	const github = deps.github ?? createGitHubAdapter(deps.run);
	const landPr = deps.landPr;
	if (!landPr) {
		return {
			status: "blocked",
			blockers: [{ code: "land-unavailable", message: "The land extension is unavailable." }],
		};
	}
	const frontiers: StackLandFrontier[] = [];
	const completedMutations: string[] = [];
	const warnings: string[] = [];
	const recoveryOperationIds: string[] = [];
	let remainingBookmarks: string[] = [];
	const settlement = await identifyWorkingCopyToSettle(options, deps, jj, initialModel, completedMutations);
	let preparedFirstIteration = true;

	const progress = (): {
		frontiers: StackLandFrontier[];
		remainingBookmarks: string[];
		completedMutations: string[];
		warnings: string[];
		recoveryOperationIds: string[];
	} => ({
		frontiers: [...frontiers],
		remainingBookmarks,
		completedMutations: [...completedMutations],
		warnings: [...warnings],
		recoveryOperationIds: [...recoveryOperationIds],
	});

	for (;;) {
		if (deps.signal?.aborted) return { status: "cancelled", ...progress() };
		const prepared = preparedFirstIteration
			? { status: "ok" as const, mapped: initialMapped, model: initialModel }
			: await remapLand(options, deps);
		preparedFirstIteration = false;
		if (prepared.status !== "ok") {
			return frontiers.length === 0
				? prepared
				: { status: "partial", error: prepared.blockers.map((blocker) => blocker.message).join(" "), ...progress() };
		}
		remainingBookmarks = prepared.mapped.map((slice) => slice.bookmark);
		const current = prepared.mapped[0];
		const frontier: StackLandFrontier = {
			bookmark: current.bookmark,
			prNumber: current.prNumber,
			url: current.url,
			expectedHeadSha: current.headCommitId,
			method,
			state: "not-attempted",
		};
		deps.ui.setStatus(`jj-stack: landing #${current.prNumber}`);

		if (current.draft && !current.alreadyMerged) {
			try {
				const remote = await jj.getRemote(options.cwd, options.remote, deps.signal);
				if (!remote.github) {
					return { status: "partial", error: `Remote ${options.remote} is not a GitHub repository.`, ...progress() };
				}
				await github.markPrReady(remote.github, current.prNumber, options.cwd, deps.signal);
				completedMutations.push(`Marked PR #${current.prNumber} ready`);
			} catch (error) {
				if (isIndeterminate(error) || deps.signal?.aborted) {
					return {
						status: "indeterminate",
						inFlight: `mark-pr-ready: ${errorMessage(error)}`,
						recovery: "Inspect the PR draft state before retrying.",
						...progress(),
					};
				}
				frontiers.push(frontier);
				return { status: "partial", error: errorMessage(error), ...progress() };
			}
		}

		if (current.alreadyMerged) {
			frontier.state = "already-merged";
			completedMutations.push(`PR #${current.prNumber} already merged; advancing`);
		} else {
			const landed = await landPr({
				prNumber: current.prNumber,
				readiness: options.readiness,
				method,
			});
			if (!landed.handled) {
				frontiers.push(frontier);
				return {
					status: "partial",
					error: "The land extension is unavailable.",
					...progress(),
				};
			}
			completedMutations.push(...landed.outcome.completedMutations);
			const pinned = landed.outcome.frontiers[0]?.expectedHeadSha;
			if (pinned) frontier.expectedHeadSha = pinned;
			if (landed.outcome.status !== "landed") {
				frontier.state = landed.outcome.status === "partially-landed" ? "queued" : "blocked";
				frontiers.push(frontier);
				return {
					status: landed.outcome.status === "failed" ? "failed" : "partial",
					error: landed.outcome.blockers.join(" ") || `Land returned ${landed.outcome.status}.`,
					...progress(),
				};
			}
			frontier.state = "landed";
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
			return { status: "partial", error: errorMessage(error), ...progress() };
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
				remainingBookmarks = remainingBookmarks.slice(1);
				return {
					status: "partial",
					error: `Merge commit ${mergeCommitOid} for PR #${current.prNumber} is not an ancestor of the refreshed trunk.`,
					...progress(),
				};
			}
			refreshedTrunkCommitId = trunk;
		} catch (error) {
			frontiers.push(frontier);
			if (isIndeterminate(error) || deps.signal?.aborted) {
				return {
					status: "indeterminate",
					inFlight: `trunk-verify: ${errorMessage(error)}`,
					recovery: `jj op restore ${operationId}`,
					...progress(),
				};
			}
			return { status: "partial", error: errorMessage(error), ...progress() };
		}

		const remainder = remainingBookmarks.slice(1);
		if (remainder.length > 0) {
			deps.ui.setStatus("jj-stack: republishing remainder");
			const published = await publishStackFromTool(
				{
					cwd: options.cwd,
					top: options.top,
					remote: options.remote,
					trunk: options.trunk,
					maxStack: options.maxStack,
				},
				deps,
			);
			if (published.status !== "completed") {
				frontiers.push(frontier);
				remainingBookmarks = remainder;
				if (published.status === "indeterminate") {
					return {
						status: "indeterminate",
						inFlight: published.inFlight.error,
						recovery: published.recovery,
						...progress(),
					};
				}
				if (published.status === "partial") {
					return { status: "partial", error: published.failedAction.error, ...progress() };
				}
				if (published.status === "failed") {
					return { status: "partial", error: published.error, ...progress() };
				}
				return { status: "partial", error: `Republish returned ${published.status}.`, ...progress() };
			}
			completedMutations.push(
				...published.completedActions.map((action) => {
					if (action.kind === "push-bookmark") return `Pushed ${action.bookmark}`;
					if (action.kind === "repair-pr-base") return `Repaired PR #${action.prNumber} base → ${action.targetBase}`;
					if (action.kind === "mark-pr-ready") return `Marked PR #${action.prNumber} ready`;
					return `Publication ${action.kind}`;
				}),
			);
		}

		try {
			const remoteSha = await github.getRemoteBranchSha(remote.github, current.bookmark, options.cwd, deps.signal);
			if (remoteSha === undefined) {
				completedMutations.push(`Remote branch ${current.bookmark} already deleted`);
			} else if (remoteSha !== frontier.expectedHeadSha) {
				warnings.push(
					`Skipped deleting ${current.bookmark}: remote SHA ${remoteSha} does not match landed head ${frontier.expectedHeadSha}`,
				);
			} else {
				const deleted = await github.deleteRemoteBranch(remote.github, current.bookmark, options.cwd, deps.signal);
				completedMutations.push(
					deleted === "deleted"
						? `Deleted remote branch ${current.bookmark}`
						: `Remote branch ${current.bookmark} already deleted`,
				);
			}
		} catch (error) {
			warnings.push(`Failed to delete remote branch ${current.bookmark}: ${errorMessage(error)}`);
		}

		frontiers.push(frontier);
		remainingBookmarks = remainder;
		if (remainder.length === 0) {
			await settleWorkingCopyOnTrunk(options, deps, jj, settlement, refreshedTrunkCommitId, completedMutations);
			return { status: "completed", ...progress() };
		}
	}
}

interface WorkingCopySettlement {
	changeId: string;
	/** Expected parent when advancing abandons a selected bookmarked checkpoint. */
	replacementParentCommitId?: string;
}

/** Identify the empty working-copy child of the selected stack before landing mutates history. */
async function identifyWorkingCopyToSettle(
	options: LandStackOptions,
	deps: OrchestratorDeps,
	jj: JjAdapter,
	model: InspectModel,
	completedMutations: string[],
): Promise<WorkingCopySettlement | undefined> {
	if (!model.topCommitId) return undefined;
	try {
		const [status, changeId] = await Promise.all([
			jj.workingCopyStatus(options.cwd, deps.signal),
			jj.workingCopyChangeId(options.cwd, deps.signal),
		]);
		if (!status?.empty || !changeId) return undefined;
		const isSelectedCheckpoint = status.bookmarked && status.commitId === model.topCommitId;
		const isUnbookmarkedChild =
			!status.bookmarked && status.parentCommitIds.length === 1 && status.parentCommitIds[0] === model.topCommitId;
		if (isSelectedCheckpoint) return { changeId, replacementParentCommitId: model.trunk.commitId };
		return isUnbookmarkedChild ? { changeId } : undefined;
	} catch (error) {
		completedMutations.push(`Could not inspect the working copy before landing: ${errorMessage(error)}`);
		return undefined;
	}
}

/**
 * After the last frontier lands, move the same empty working-copy child onto
 * refreshed trunk. Best-effort: a failure never degrades a completed landing.
 */
async function settleWorkingCopyOnTrunk(
	options: LandStackOptions,
	deps: OrchestratorDeps,
	jj: JjAdapter,
	candidate: WorkingCopySettlement | undefined,
	refreshedTrunkCommitId: string | undefined,
	completedMutations: string[],
): Promise<void> {
	if (!candidate || !refreshedTrunkCommitId) return;
	try {
		const [status, changeId] = await Promise.all([
			jj.workingCopyStatus(options.cwd, deps.signal),
			jj.workingCopyChangeId(options.cwd, deps.signal),
		]);
		if (!status?.empty || status.bookmarked) return;
		const sameChange = changeId === candidate.changeId;
		const expectedReplacement =
			candidate.replacementParentCommitId !== undefined &&
			status.parentCommitIds.length === 1 &&
			status.parentCommitIds[0] === candidate.replacementParentCommitId;
		if (!sameChange && !expectedReplacement) return;
		if (await jj.isAncestor(options.cwd, refreshedTrunkCommitId, status.commitId, deps.signal)) return;
		await jj.rebaseWorkingCopy(options.cwd, refreshedTrunkCommitId, deps.signal);
		completedMutations.push("Rebased the empty working copy onto the refreshed trunk");
	} catch (error) {
		completedMutations.push(`Left the working copy in place: ${errorMessage(error)}`);
	}
}

function isIndeterminate(error: unknown): boolean {
	return (error instanceof JjError || error instanceof GitHubError) && error.kind === "indeterminate";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
