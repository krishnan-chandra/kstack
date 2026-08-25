import type { AutopilotResult } from "../pr-autopilot/types.ts";
import { getPullRequest, getRepository, mergePullRequest, waitForMerge } from "../shared/github.ts";
import { isLandConfirmation } from "./confirmation.ts";
import type { ExecFn, FrontierResult, LandOptions, LandResult, MergeMethod } from "./types.ts";

interface LandDeps {
	exec: ExecFn;
	cwd: string;
	signal: AbortSignal;
	runAutopilot(
		mode: "check" | "watch",
		pr: number,
	): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }>;
	selectMethod(allowed: MergeMethod[]): Promise<MergeMethod | undefined>;
	confirmMerge(preview: string): Promise<boolean>;
	now(): number;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	/** Per-repo method from kstack.json land config, or undefined. */
	configuredMethodFor?: (nameWithOwner: string) => MergeMethod | undefined;
}

/* exported: shared readiness guidance for Graphite stack landing */
export function readinessBlockers(
	input: { readiness: LandOptions["readiness"]; prNumber: number },
	autopilot: AutopilotResult,
): string[] {
	if (input.readiness === "watch" && autopilot.blockedCodes?.includes("ci-pending-after-watch")) {
		return [
			`Watch is bounded. Inspect PR #${input.prNumber}, then retry /land after CI settles. Do not rebase or republish unless the PR head or base changed.`,
			...autopilot.blockedReasons,
		];
	}
	return autopilot.blockedReasons;
}

function empty(status: LandResult["status"], blocker: string): LandResult {
	return {
		status,
		frontiers: [],
		autopilotRan: false,
		remainingRefs: [],
		completedMutations: [],
		blockers: [blocker],
	};
}

export async function runLand(options: LandOptions, deps: LandDeps): Promise<LandResult> {
	let acceptedMutation = false;
	let frontier: FrontierResult | undefined;
	let autopilotStatus: AutopilotResult["status"] | undefined;
	const completedMutations: string[] = [];
	try {
		const repo = await getRepository(deps.exec, deps.cwd, deps.signal);
		const initial = await getPullRequest(deps.exec, deps.cwd, options.target.prNumber, deps.signal);
		if (initial.state !== "OPEN") return empty("blocked", `PR #${initial.number} is ${initial.state.toLowerCase()}.`);

		// Reject impossible repository/method combinations before readiness work,
		// because autopilot may itself perform confirmed mutations.
		if (repo.allowedMethods.length === 0) {
			return empty(
				"blocked",
				"Repository only allows merge commits; kstack does not support merge commits. Enable squash or rebase merging in repository settings.",
			);
		}
		const configuredMethod = deps.configuredMethodFor?.(repo.nameWithOwner);
		const preselected = options.method ?? configuredMethod;
		if (preselected && !repo.allowedMethods.includes(preselected)) {
			return empty(
				"blocked",
				`Merge method ${preselected} is not enabled for ${repo.nameWithOwner}. Enabled methods: ${repo.allowedMethods.join(", ")}.`,
			);
		}

		const readiness = await deps.runAutopilot(options.readiness, initial.number);
		if (!readiness.handled) return empty("blocked", "pr-autopilot extension is unavailable.");
		const autopilot = readiness.outcome;
		autopilotStatus = autopilot.status;
		const base = {
			frontiers: [],
			autopilotRan: true,
			autopilotStatus,
			remainingRefs: [],
			completedMutations: [],
			blockers: [],
		};
		if (
			autopilot.status !== "merge-ready" ||
			!autopilot.mergeReady ||
			!autopilot.prState ||
			autopilot.prState.verifiedHeadSha !== autopilot.prState.headSha
		) {
			return {
				...base,
				status: "blocked",
				blockers: autopilot.blockedReasons.length
					? readinessBlockers({ readiness: options.readiness, prNumber: initial.number }, autopilot)
					: ["Autopilot did not produce exact-head merge-ready evidence."],
			};
		}

		const ready = await getPullRequest(deps.exec, deps.cwd, initial.number, deps.signal);
		if (
			ready.state !== "OPEN" ||
			ready.isDraft ||
			ready.headOid !== autopilot.prState.headSha ||
			ready.headRef !== autopilot.prState.headRef
		) {
			return {
				...base,
				status: "blocked",
				blockers: ["GitHub no longer matches autopilot's exact-head readiness evidence."],
			};
		}
		// Priority: CLI --method > per-repo config > only allowed method > prompt
		const autoSelectedOnlyMethod = !preselected && repo.allowedMethods.length === 1;
		let method = preselected;
		if (autoSelectedOnlyMethod) {
			method = repo.allowedMethods[0];
		} else if (!method) {
			method = await deps.selectMethod(repo.allowedMethods);
		}
		if (!method) return { ...base, status: "declined", blockers: ["No merge method selected."] };

		frontier = {
			prNumber: ready.number,
			url: ready.url,
			expectedHeadSha: ready.headOid,
			method,
			state: "not-attempted",
		};
		// Skip confirmation when only one repository-supported method was
		// auto-selected, when the method comes from per-repo config (not CLI
		// --method), or when a caller presents a minted confirmation capability.
		const skipConfirm =
			autoSelectedOnlyMethod ||
			isLandConfirmation(options.confirmation) ||
			(configuredMethod !== undefined && options.method === undefined);
		if (!skipConfirm) {
			const confirmed = await deps.confirmMerge(
				`${ready.url}\n${ready.headRef} -> ${ready.baseRef}\nPinned head: ${ready.headOid}\nMethod: ${method}\nGitHub may enqueue this PR when a merge queue is required.`,
			);
			if (!confirmed)
				return { ...base, status: "declined", frontiers: [frontier], blockers: ["Merge confirmation declined."] };
		}

		const revalidated = await getPullRequest(deps.exec, deps.cwd, ready.number, deps.signal);
		if (
			revalidated.state !== "OPEN" ||
			revalidated.isDraft ||
			revalidated.headOid !== frontier.expectedHeadSha ||
			revalidated.headRef !== ready.headRef
		) {
			return {
				...base,
				status: "blocked",
				frontiers: [frontier],
				blockers: ["PR changed after confirmation; merge was not attempted."],
			};
		}
		await mergePullRequest(deps.exec, deps.cwd, ready.number, method, ready.headOid, deps.signal);
		acceptedMutation = true;
		completedMutations.push(`GitHub accepted merge/queue request for PR #${ready.number}`);

		const verified = await waitForMerge(
			deps.exec,
			deps.cwd,
			ready.number,
			ready.headRef,
			ready.headOid,
			deps,
			deps.signal,
		);
		if (!verified.merged)
			return {
				...base,
				status: "partially-landed",
				frontiers: [{ ...frontier, state: "queued" }],
				completedMutations,
				blockers: ["GitHub accepted the request, but remote MERGED state was not verified before stopping."],
			};
		return {
			...base,
			status: "landed",
			frontiers: [{ ...frontier, state: "landed" }],
			completedMutations: [...completedMutations, `Verified PR #${ready.number} merged remotely`],
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (acceptedMutation && frontier) {
			return {
				status: "partially-landed",
				frontiers: [{ ...frontier, state: "queued" }],
				autopilotRan: autopilotStatus !== undefined,
				autopilotStatus,
				remainingRefs: [],
				completedMutations,
				blockers: [
					deps.signal.aborted ? "Verification was aborted after GitHub accepted the merge/queue request." : reason,
				],
			};
		}
		if (deps.signal.aborted)
			return empty("aborted", "Landing was aborted before GitHub accepted a merge/queue request.");
		return empty("failed", reason);
	}
}
