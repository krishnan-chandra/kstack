import type { StackLandOutcome, StackPrefixLandOutcome } from "../shared/stack/outcome.ts";
import type { VcsBackendId } from "../shared/vcs/config.ts";
import { isLandConfirmation } from "./confirmation.ts";
import type { GraphiteLandingResponse } from "./graphite-stack-landing.ts";
import { blockedLandResult } from "./result.ts";
import type { FrontierResult, LandOptions, LandResult } from "./types.ts";

type StackLandingResponse = { handled: false } | { handled: true; outcome: StackPrefixLandOutcome };

interface RouteLandDeps {
	backend: VcsBackendId;
	requestStackLanding(): Promise<StackLandingResponse>;
	requestGraphiteStackLanding?(): Promise<GraphiteLandingResponse>;
	runSingle(): Promise<LandResult>;
}

function mapStackOutcome(outcome: StackLandOutcome): LandResult {
	const stackFrontiers = "frontiers" in outcome ? (outcome.frontiers ?? []) : [];
	const frontiers: FrontierResult[] = stackFrontiers.map((frontier) => ({
		prNumber: frontier.prNumber,
		url: frontier.url,
		expectedHeadSha: frontier.expectedHeadSha,
		method: frontier.method,
		state: frontier.state === "already-merged" ? "landed" : frontier.state,
	}));
	const completedMutations = "completedMutations" in outcome ? [...(outcome.completedMutations ?? [])] : [];
	const warnings = "warnings" in outcome ? [...(outcome.warnings ?? [])] : [];
	const remainingRefs = "remainingRefs" in outcome ? [...outcome.remainingRefs] : [];
	const recoveryOperationIds = "recoveryOperationIds" in outcome ? outcome.recoveryOperationIds : undefined;
	const recoveryOperationId = recoveryOperationIds?.at(-1);
	const autopilotRan = stackFrontiers.some((frontier) => frontier.state !== "already-merged");

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
		return {
			status: mutationAccepted ? "partially-landed" : "blocked",
			frontiers,
			autopilotRan,
			remainingRefs,
			completedMutations,
			warnings,
			recoveryOperationId,
			blockers: [blocker],
		};
	}
	if (outcome.status === "blocked") return blockedLandResult(outcome.blockers.map((item) => item.message).join(" "));
	if (outcome.status === "declined") {
		return {
			...blockedLandResult("Stack landing confirmation declined."),
			status: "declined",
		};
	}
	if (outcome.status === "busy") return blockedLandResult(outcome.message);
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

export async function routeLand(options: LandOptions, deps: RouteLandDeps): Promise<LandResult> {
	if (deps.backend === "git") return deps.runSingle();
	if (deps.backend === "graphite") {
		if (!deps.requestGraphiteStackLanding)
			return blockedLandResult(
				"Graphite stack landing is unavailable; refusing a possible individual middle-stack merge.",
			);
		try {
			const response = await deps.requestGraphiteStackLanding();
			return response.status === "not-stack" ? deps.runSingle() : response.outcome;
		} catch (error) {
			return blockedLandResult(
				`Could not inspect Graphite stack topology: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (isLandConfirmation(options.confirmation)) return deps.runSingle();

	let response: StackLandingResponse;
	try {
		response = await deps.requestStackLanding();
	} catch (error) {
		return blockedLandResult(
			`Could not inspect the selected PR for jj stack membership: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!response.handled) {
		return blockedLandResult(
			"The jj-stacked-prs extension is unavailable; refusing a possible individual middle-stack merge.",
		);
	}
	if (response.outcome.status === "not-stack") return deps.runSingle();
	return mapStackOutcome(response.outcome.outcome);
}
