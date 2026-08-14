import type { AutopilotResult } from "../pr-autopilot/driver.ts";
import { getPullRequest, getRepository, mergePullRequest, waitForMerge } from "./github.ts";
import type { ExecFn, LandOptions, LandResult, MergeMethod } from "./types.ts";
export interface LandDeps {
	exec: ExecFn; cwd: string; signal: AbortSignal;
	runAutopilot(mode: "check" | "watch", pr: number): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }>;
	selectMethod(allowed: MergeMethod[]): Promise<MergeMethod | undefined>;
	confirmMerge(preview: string): Promise<boolean>;
	now(): number; sleep(ms: number, signal: AbortSignal): Promise<void>;
}
const empty = (status: LandResult["status"], blocker: string): LandResult => ({ status, frontiers: [], autopilotRan: false, remainingBookmarks: [], completedMutations: [], blockers: [blocker] });
export async function runLand(options: LandOptions, deps: LandDeps): Promise<LandResult> {
	if (options.target.kind === "stack") return { ...empty("blocked", "Stack landing requires the canonical jj advance helper and is unavailable in this build."), stackTop: options.target.topBookmark };
	try {
		const repo = await getRepository(deps.exec, deps.cwd, deps.signal);
		let pr = await getPullRequest(deps.exec, deps.cwd, options.target.prNumber, deps.signal);
		if (pr.headRef !== options.target.expectedHeadRef) return empty("blocked", `PR head ${pr.headRef} does not match expected ${options.target.expectedHeadRef}.`);
		if (pr.state !== "OPEN" || pr.isDraft) return empty("blocked", `PR #${pr.number} is ${pr.isDraft ? "draft" : pr.state.toLowerCase()}.`);
		const readiness = await deps.runAutopilot(options.readiness, pr.number);
		if (!readiness.handled) return empty("blocked", "pr-autopilot extension is unavailable.");
		const ap = readiness.outcome;
		const base = { frontiers: [], autopilotRan: true, autopilotStatus: ap.status, remainingBookmarks: [], completedMutations: [], blockers: [] };
		if (ap.status !== "merge-ready" || !ap.mergeReady || !ap.prState || ap.prState.verifiedHeadSha !== ap.prState.headSha || ap.prState.headSha !== pr.headOid) return { ...base, status: "blocked", blockers: ap.blockedReasons.length ? ap.blockedReasons : ["Autopilot did not produce exact-head merge-ready evidence."] };
		const method = options.method ?? await deps.selectMethod(repo.allowedMethods);
		if (!method) return { ...base, status: "declined", blockers: ["No merge method selected."] };
		if (!repo.allowedMethods.includes(method)) return { ...base, status: "blocked", blockers: [`Repository does not allow ${method} merges.`] };
		const frontier = { prNumber: pr.number, url: pr.url, expectedHeadSha: pr.headOid, method, state: "not-attempted" as const };
		const confirmed = await deps.confirmMerge(`${pr.url}\n${pr.headRef} -> ${pr.baseRef}\nPinned head: ${pr.headOid}\nMethod: ${method}\nGitHub may enqueue this PR when a merge queue is required.`);
		if (!confirmed) return { ...base, status: "declined", frontiers: [frontier], blockers: ["Merge confirmation declined."] };
		pr = await getPullRequest(deps.exec, deps.cwd, pr.number, deps.signal);
		if (pr.state !== "OPEN" || pr.isDraft || pr.headOid !== frontier.expectedHeadSha || pr.headRef !== options.target.expectedHeadRef) return { ...base, status: "blocked", frontiers: [frontier], blockers: ["PR changed after confirmation; merge was not attempted."] };
		await mergePullRequest(deps.exec, deps.cwd, pr.number, method, pr.headOid, deps.signal);
		const completedMutations = [`GitHub accepted merge/queue request for PR #${pr.number}`];
		const verified = await waitForMerge(deps.exec, deps.cwd, pr.number, pr.headRef, pr.headOid, deps, deps.signal);
		if (!verified.merged) return { ...base, status: "partially-landed", frontiers: [{ ...frontier, state: "queued" }], completedMutations, blockers: ["GitHub accepted the request, but remote MERGED state was not verified before stopping."] };
		return { ...base, status: "landed", frontiers: [{ ...frontier, state: "landed" }], completedMutations: [...completedMutations, `Verified PR #${pr.number} merged remotely`] };
	} catch (error) {
		if (deps.signal.aborted) return empty("aborted", "Landing was aborted; an accepted merge cannot be undone automatically.");
		return empty("failed", error instanceof Error ? error.message : String(error));
	}
}
