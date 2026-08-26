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

function mapStackOutcome(outcome: StackLandOutcome): LandResult {
	if (outcome.status === "blocked") return blockedLandResult(outcome.blockers.map((item) => item.message).join(" "));
	if (outcome.status === "declined") {
		return {
			...blockedLandResult("Stack landing confirmation declined."),
			status: "declined",
		};
	}
	if (outcome.status === "busy") return blockedLandResult(outcome.message);

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
	const recoveryOperationId = outcome.recoveryOperationIds.at(-1);
	const autopilotRan = outcome.frontiers.some((frontier) => frontier.state !== "already-merged");

	if (outcome.status === "completed") {
		return {
			status: "landed",
			frontiers,
			autopilotRan,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationId,
			blockers: [],
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
			autopilotRan,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationId,
			blockers: [blocker],
		};
	}
	if (outcome.status === "cancelled") {
		return {
			status: "aborted",
			frontiers,
			autopilotRan,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationId,
			blockers: ["Stack landing was cancelled."],
		};
	}
	return {
		status: "failed",
		frontiers,
		autopilotRan,
		remainingRefs,
		completedMutations,
		warnings,
		recoveryOperationId,
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
