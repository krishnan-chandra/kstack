import type { StackLandOutcome, StackPrefixLandOutcome } from "../jj-stacked-prs/types.ts";
import type { VcsBackendId } from "../shared/vcs/config.ts";
import { isLandConfirmation } from "./confirmation.ts";
import type { GraphiteLandingResponse } from "./graphite-stack-landing.ts";
import type { FrontierResult, LandOptions, LandResult } from "./types.ts";

type StackLandingResponse = { handled: false } | { handled: true; outcome: StackPrefixLandOutcome };

interface RouteLandDeps {
	backend: VcsBackendId;
	requestStackLanding(): Promise<StackLandingResponse>;
	requestGraphiteStackLanding?(): Promise<GraphiteLandingResponse>;
	runSingle(): Promise<LandResult>;
}

function blocked(reason: string): LandResult {
	return {
		status: "blocked",
		frontiers: [],
		autopilotRan: false,
		remainingBookmarks: [],
		completedMutations: [],
		blockers: [reason],
	};
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
	const remainingBookmarks = "remainingBookmarks" in outcome ? [...outcome.remainingBookmarks] : [];
	const recoveryOperationIds = "recoveryOperationIds" in outcome ? outcome.recoveryOperationIds : undefined;
	const recoveryOperationId = recoveryOperationIds?.at(-1);
	const autopilotRan = stackFrontiers.some((frontier) => frontier.state !== "already-merged");

	if (outcome.status === "completed") {
		return {
			status: "landed",
			frontiers,
			autopilotRan,
			remainingBookmarks,
			completedMutations,
			recoveryOperationId,
			blockers: [],
		};
	}
	if (outcome.status === "partial" || outcome.status === "indeterminate") {
		const blocker = outcome.status === "partial" ? outcome.error : outcome.inFlight;
		return {
			status: "partially-landed",
			frontiers,
			autopilotRan,
			remainingBookmarks,
			completedMutations,
			recoveryOperationId,
			blockers: [blocker],
		};
	}
	if (outcome.status === "blocked") return blocked(outcome.blockers.map((item) => item.message).join(" "));
	if (outcome.status === "declined") {
		return {
			...blocked("Stack landing confirmation declined."),
			status: "declined",
		};
	}
	if (outcome.status === "busy") return blocked(outcome.message);
	if (outcome.status === "cancelled") {
		return {
			status: "aborted",
			frontiers,
			autopilotRan,
			remainingBookmarks,
			completedMutations,
			recoveryOperationId,
			blockers: ["Stack landing was cancelled."],
		};
	}
	return {
		status: "failed",
		frontiers,
		autopilotRan,
		remainingBookmarks,
		completedMutations,
		recoveryOperationId,
		blockers: [outcome.error],
	};
}

export async function routeLand(options: LandOptions, deps: RouteLandDeps): Promise<LandResult> {
	if (deps.backend === "git") return deps.runSingle();
	if (deps.backend === "graphite") {
		if (!deps.requestGraphiteStackLanding)
			return blocked("Graphite stack landing is unavailable; refusing a possible individual middle-stack merge.");
		try {
			const response = await deps.requestGraphiteStackLanding();
			return response.status === "not-stack" ? deps.runSingle() : response.outcome;
		} catch (error) {
			return blocked(
				`Could not inspect Graphite stack topology: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (isLandConfirmation(options.confirmation)) return deps.runSingle();

	let response: StackLandingResponse;
	try {
		response = await deps.requestStackLanding();
	} catch (error) {
		return blocked(
			`Could not inspect the selected PR for jj stack membership: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!response.handled) {
		return blocked("The jj-stacked-prs extension is unavailable; refusing a possible individual middle-stack merge.");
	}
	if (response.outcome.status === "not-stack") return deps.runSingle();
	return mapStackOutcome(response.outcome.outcome);
}
