/** Preserve and restore an empty jj working-copy child across stack settlement. */

import { errorMessage } from "./errors.ts";
import type { JjAdapter } from "./jj.ts";
import type { OrchestratorDeps } from "./orchestrator.ts";
import type { InspectModel } from "./types.ts";

interface SettlementOptions {
	cwd: string;
	trunk?: string;
}

interface WorkingCopySettlement {
	changeId: string;
	/** Expected parent when advancing abandons a selected bookmarked checkpoint. */
	replacementParentCommitId?: string;
}

export async function identifyWorkingCopyToSettle(
	options: SettlementOptions,
	deps: OrchestratorDeps,
	jj: JjAdapter,
	model: InspectModel,
	warnings: string[],
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
		warnings.push(`Could not inspect the working copy before landing: ${errorMessage(error)}`);
		return undefined;
	}
}

export async function settleWorkingCopyOnTrunk(
	options: SettlementOptions,
	deps: OrchestratorDeps,
	jj: JjAdapter,
	candidate: WorkingCopySettlement | undefined,
	refreshedTrunkCommitId: string | undefined,
	completedMutations: string[],
	warnings: string[],
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
		warnings.push(`Left the working copy in place: ${errorMessage(error)}`);
	}
}
