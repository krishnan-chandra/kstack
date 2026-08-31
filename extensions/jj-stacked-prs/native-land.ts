/** GitHub-native full-stack preparation, merge submission, queue watch, and jj settlement. */

import { isCodeReady } from "../pr-autopilot/api.ts";
import { mapWithConcurrencyLimit } from "../shared/concurrency.ts";
import type { StackLandFrontier, StackLandOutcome } from "../shared/stack/outcome.ts";
import { errorMessage, isIndeterminate } from "./errors.ts";
import { type NativeStack, type NativeStackGateway, samePrNumbers } from "./native-stack.ts";
import { applyAdvance, type ResolvedOrchestratorDeps } from "./orchestrator.ts";
import type { InspectModel, StackMergeMethod, StackReadinessMode } from "./types.ts";
import { identifyWorkingCopyToSettle, settleWorkingCopyOnTrunk } from "./working-copy-settlement.ts";

const NATIVE_QUEUE_POLL_MS = 10_000;
const NATIVE_QUEUE_WATCH_MS = 30 * 60_000;
const NATIVE_READ_CONCURRENCY = 4;

interface NativeLandOptions {
	cwd: string;
	remote: string;
	trunk?: string;
	readiness: StackReadinessMode;
}

interface NativeLandSlice {
	bookmark: string;
	prNumber: number;
	url: string;
	headCommitId: string;
	baseRef: string;
	draft: boolean;
	alreadyMerged: boolean;
}

export async function runNativeLand(
	options: NativeLandOptions,
	deps: ResolvedOrchestratorDeps,
	method: StackMergeMethod,
	model: InspectModel,
	mapped: NativeLandSlice[],
	nativeStack: NativeStack,
	repository: { owner: string; repo: string },
	native: NativeStackGateway,
): Promise<StackLandOutcome> {
	const jj = deps.jj;
	const github = deps.github;
	const frontiers: StackLandFrontier[] = mapped.map((slice) => ({
		ref: slice.bookmark,
		prNumber: slice.prNumber,
		url: slice.url,
		expectedHeadSha: slice.headCommitId,
		method,
		state: "not-attempted",
	}));
	const completedMutations: string[] = [];
	const warnings: string[] = [];
	const recoveryOperationIds: string[] = [];
	const remainingRefs = mapped.map((slice) => slice.bookmark);
	const progress = () => ({
		frontiers: [...frontiers],
		remainingRefs,
		completedMutations: [...completedMutations],
		warnings: [...warnings],
		recoveryOperationIds: [...recoveryOperationIds],
	});
	const workingCopy = await identifyWorkingCopyToSettle(options, deps, jj, model, warnings);

	try {
		if (!deps.preparePr) {
			return {
				status: "blocked",
				blockers: [{ code: "land-unavailable", message: "pr-autopilot extension is unavailable." }],
			};
		}
		for (const slice of mapped) {
			if (slice.alreadyMerged) continue;
			deps.ui.setStatus(`jj-stack: preparing #${slice.prNumber}`);
			let response = await deps.preparePr({
				prNumber: slice.prNumber,
				expectedHeadSha: slice.headCommitId,
				readiness: options.readiness,
			});
			if (!response.handled) {
				if (completedMutations.length === 0) {
					return {
						status: "blocked",
						blockers: [{ code: "land-unavailable", message: "pr-autopilot extension is unavailable." }],
					};
				}
				return { status: "partial", error: "pr-autopilot extension became unavailable.", ...progress() };
			}
			if (
				slice.draft &&
				response.outcome.prState?.isDraft === true &&
				response.outcome.prState.headSha === slice.headCommitId &&
				isCodeReady(response.outcome.prState)
			) {
				await github.markPrReady(repository, slice.prNumber, options.cwd, deps.signal);
				completedMutations.push(`Marked PR #${slice.prNumber} ready`);
				response = await deps.preparePr({
					prNumber: slice.prNumber,
					expectedHeadSha: slice.headCommitId,
					readiness: options.readiness,
				});
				if (!response.handled) {
					return { status: "partial", error: "pr-autopilot extension became unavailable.", ...progress() };
				}
			}
			const outcome = response.outcome;
			if (
				outcome.status !== "merge-ready" ||
				outcome.prState?.verifiedHeadSha !== slice.headCommitId ||
				outcome.prState.headSha !== slice.headCommitId
			) {
				return {
					status: "partial",
					error: `PR #${slice.prNumber} did not produce merge-ready evidence for pinned head ${slice.headCommitId}.`,
					...progress(),
				};
			}
		}

		const fresh = await native.inspectForPullRequest({
			cwd: options.cwd,
			repo: repository,
			prNumber: mapped[mapped.length - 1].prNumber,
			signal: deps.signal,
		});
		if (
			!fresh ||
			fresh.stackNumber !== nativeStack.stackNumber ||
			(fresh.baseSha !== undefined && nativeStack.baseSha !== undefined && fresh.baseSha !== nativeStack.baseSha) ||
			!nativeGenerationMatches(fresh, mapped)
		) {
			return {
				status: "partial",
				error:
					"Native stack heads or ordering changed during readiness preparation; run landing again with a fresh plan.",
				...progress(),
			};
		}

		deps.ui.setStatus(`jj-stack: merging native stack #${nativeStack.stackNumber}`);
		let merged = await native.mergeThrough({
			cwd: options.cwd,
			repo: repository,
			prNumber: mapped[mapped.length - 1].prNumber,
			method,
			signal: deps.signal,
		});
		if (merged.status === "enqueued" && options.readiness === "watch") {
			const watched = await watchQueuedNativeStack({
				options,
				deps,
				native,
				repository,
				stackNumber: nativeStack.stackNumber,
				mapped,
			});
			if (watched.status === "merged") merged = { status: "merged", stack: watched.stack };
			else if (watched.status === "failed") return { status: "partial", error: watched.error, ...progress() };
		}
		if (merged.status === "enqueued") {
			for (let index = 0; index < frontiers.length; index++)
				frontiers[index] = { ...frontiers[index], state: "queued" };
			return {
				status: "queued",
				nativeStackNumber: nativeStack.stackNumber,
				submittedAt: new Date((deps.now ?? Date.now)()).toISOString(),
				...progress(),
			};
		}
		if (merged.status === "indeterminate") {
			return {
				status: "indeterminate",
				inFlight: merged.error,
				recovery: "Inspect the native stack before retrying; do not submit another merge while one may be pending.",
				...progress(),
			};
		}
		if (merged.status === "failed") return { status: "partial", error: merged.error, ...progress() };

		const verifications = await mapWithConcurrencyLimit(mapped, NATIVE_READ_CONCURRENCY, (slice) =>
			github.getMergeCommit(repository, slice.prNumber, options.cwd, deps.signal),
		);
		const mergeOids: string[] = [];
		for (const [index, slice] of mapped.entries()) {
			const verification = verifications[index];
			if (
				!verification.merged ||
				!verification.mergeCommitOid ||
				verification.headCommitId !== slice.headCommitId ||
				verification.headRef !== slice.bookmark
			) {
				return {
					status: "partial",
					error: `PR #${slice.prNumber} did not match its pinned merged head.`,
					...progress(),
				};
			}
			mergeOids.push(verification.mergeCommitOid);
			frontiers[index] = { ...frontiers[index], state: "landed" };
		}

		const operationId = await jj.currentOperationId(options.cwd, deps.signal);
		recoveryOperationIds.push(operationId);
		const topBookmark = mapped[mapped.length - 1].bookmark;
		const advanced = await applyAdvance({ ...options, top: topBookmark, merged: topBookmark }, deps, {
			jj,
			operationId,
			trunkCommitId: model.trunk.commitId,
			trunkRevset: options.trunk ?? "trunk()",
		});
		if (advanced.status !== "completed") {
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
					: `Native stack advance returned ${advanced.status}.`;
			return { status: "partial", error, ...progress() };
		}
		completedMutations.push(`Abandoned the landed native stack through ${topBookmark}`);
		const trunk = await jj.resolveRevset(options.cwd, options.trunk ?? "trunk()", deps.signal);
		const ancestry = await jj.areAncestors(options.cwd, mergeOids, trunk, deps.signal);
		const missingMergeIndex = ancestry.findIndex((isAncestor) => !isAncestor);
		if (missingMergeIndex >= 0) {
			return {
				status: "partial",
				error: `Merged commit ${mergeOids[missingMergeIndex]} is not on refreshed trunk.`,
				...progress(),
			};
		}
		const remoteShas = await mapWithConcurrencyLimit(mapped, NATIVE_READ_CONCURRENCY, (slice) =>
			github.getRemoteBranchSha(repository, slice.bookmark, options.cwd, deps.signal),
		);
		for (const [index, slice] of mapped.entries()) {
			const remoteSha = remoteShas[index];
			if (remoteSha === slice.headCommitId) {
				await github.deleteRemoteBranch(repository, slice.bookmark, options.cwd, deps.signal);
				completedMutations.push(`Deleted remote branch ${slice.bookmark}`);
			} else if (remoteSha !== undefined) {
				warnings.push(`Skipped deleting ${slice.bookmark}: remote SHA no longer matches the pinned head`);
			}
		}
		await settleWorkingCopyOnTrunk(options, deps, jj, workingCopy, trunk, completedMutations, warnings);
		return { status: "completed", ...progress(), remainingRefs: [] };
	} catch (error) {
		if (isIndeterminate(error)) {
			return {
				status: "indeterminate",
				inFlight: errorMessage(error),
				recovery: recoveryOperationIds.length > 0 ? `jj op restore ${recoveryOperationIds.at(-1)}` : undefined,
				...progress(),
			};
		}
		return { status: "partial", error: errorMessage(error), ...progress() };
	}
}

async function watchQueuedNativeStack(input: {
	options: NativeLandOptions;
	deps: ResolvedOrchestratorDeps;
	native: NativeStackGateway;
	repository: { owner: string; repo: string };
	stackNumber: number;
	mapped: readonly NativeLandSlice[];
}): Promise<{ status: "merged"; stack: NativeStack } | { status: "queued" } | { status: "failed"; error: string }> {
	const now = input.deps.now ?? Date.now;
	const deadline = now() + NATIVE_QUEUE_WATCH_MS;
	while (now() < deadline) {
		if (input.deps.signal?.aborted) return { status: "queued" };
		await sleepFor(input.deps, NATIVE_QUEUE_POLL_MS);
		if (input.deps.signal?.aborted || now() >= deadline) return { status: "queued" };
		const stack = await input.native.inspectForPullRequest({
			cwd: input.options.cwd,
			repo: input.repository,
			prNumber: input.mapped[input.mapped.length - 1].prNumber,
			signal: input.deps.signal,
		});
		if (!stack || stack.stackNumber !== input.stackNumber) {
			return { status: "failed", error: "Queued native stack membership changed while waiting for GitHub." };
		}
		if (stack.pullRequests.every((pr) => pr.mergedAt)) return { status: "merged", stack };
		const failed = stack.pullRequests.find((pr) => pr.state === "closed" && !pr.mergedAt);
		if (failed) return { status: "failed", error: `Queued PR #${failed.number} closed without merging.` };
	}
	return { status: "queued" };
}

async function sleepFor(deps: ResolvedOrchestratorDeps, ms: number): Promise<void> {
	if (deps.signal?.aborted) return;
	if (deps.sleep) return deps.sleep(ms, deps.signal);
	await new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			deps.signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		deps.signal?.addEventListener("abort", finish, { once: true });
	});
}

function nativeGenerationMatches(stack: NativeStack, mapped: readonly NativeLandSlice[]): boolean {
	return (
		samePrNumbers(
			stack.pullRequests.map((pr) => pr.number),
			mapped.map((slice) => slice.prNumber),
		) &&
		stack.pullRequests.every(
			(pr, index) => pr.head.ref === mapped[index].bookmark && pr.head.sha === mapped[index].headCommitId,
		)
	);
}
