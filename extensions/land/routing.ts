import type { StackLandOutcome, StackPrefixLandOutcome } from "../shared/stack/outcome.ts";
import type { StackProviderId } from "../shared/stack/provider.ts";
import { blockedLandResult } from "./result.ts";
import type { FrontierResult, LandResult } from "./types.ts";

type StackLandingResponse = { handled: false } | { handled: true; outcome: StackPrefixLandOutcome };

interface RouteLandDeps {
	provider: StackProviderId | undefined;
	requestStackLanding(): Promise<StackLandingResponse>;
	runSingle(): Promise<LandResult>;
}

/** A result for an outcome without progress, keeping any warning from the stack transaction. */
function unstartedLandResult(reason: string, warnings: readonly string[] = []): LandResult {
	return { ...blockedLandResult(reason), warnings: [...warnings] };
}

function mapStackOutcome(outcome: StackLandOutcome): LandResult {
	if (outcome.status === "blocked") {
		return unstartedLandResult(outcome.blockers.map((item) => item.message).join(" "), outcome.warnings);
	}
	if (outcome.status === "declined") {
		return { ...unstartedLandResult("Stack landing confirmation declined.", outcome.warnings), status: "declined" };
	}
	if (outcome.status === "busy") return unstartedLandResult(outcome.message, outcome.warnings);
	if (outcome.status === "stale") {
		return unstartedLandResult(
			"The stack changed after the landing plan was confirmed, so nothing was landed. Run /land again to review the fresh plan.",
			outcome.warnings,
		);
	}

	const frontiers: FrontierResult[] = outcome.frontiers.map((frontier) => ({
		prNumber: frontier.prNumber,
		url: frontier.url,
		expectedHeadSha: frontier.expectedHeadSha,
		method: frontier.method,
		state: frontier.state === "already-merged" ? "landed" : frontier.state,
	}));
	const completedMutations = [...outcome.completedMutations];
	const warnings = [...outcome.warnings];
	const remainingRefs = [...outcome.remainingRefs];
	const recoveryOperationIds = [...outcome.recoveryOperationIds];

	if (outcome.status === "completed") {
		return {
			status: "landed",
			frontiers,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationIds,
			blockers: [],
		};
	}
	if (outcome.status === "queued") {
		return {
			status: "partially-landed",
			frontiers,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationIds,
			blockers: [`Native stack #${outcome.nativeStackNumber} is queued for merge.`],
		};
	}
	if (outcome.status === "waiting") {
		return {
			status: "blocked",
			frontiers,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationIds,
			blockers: [outcome.reason],
		};
	}
	if (outcome.status === "partial" || outcome.status === "indeterminate") {
		const blocker = outcome.status === "partial" ? outcome.error : outcome.inFlight;
		const mutationAccepted = frontiers.some((frontier) => frontier.state === "landed" || frontier.state === "queued");
		let status: LandResult["status"] = "blocked";
		if (outcome.status === "indeterminate") status = "indeterminate";
		else if (mutationAccepted) status = "partially-landed";
		return {
			status,
			frontiers,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationIds,
			blockers: [blocker],
		};
	}
	if (outcome.status === "cancelled") {
		return {
			status: "aborted",
			frontiers,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationIds,
			blockers: ["Stack landing was cancelled."],
		};
	}
	return {
		status: "failed",
		frontiers,
		remainingRefs,
		completedMutations,
		warnings,
		recoveryOperationIds,
		blockers: [outcome.error],
	};
}

export async function routeLand(deps: RouteLandDeps): Promise<LandResult> {
	if (deps.provider === undefined) return deps.runSingle();

	let response: StackLandingResponse;
	try {
		response = await deps.requestStackLanding();
	} catch (error) {
		return blockedLandResult(
			`Could not inspect the selected PR for ${deps.provider} stack membership: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!response.handled) {
		return blockedLandResult(
			`The ${deps.provider}-stacked-prs extension is unavailable; refusing a possible individual middle-stack merge.`,
		);
	}
	if (response.outcome.status === "not-stack") return deps.runSingle();
	return mapStackOutcome(response.outcome.outcome);
}
