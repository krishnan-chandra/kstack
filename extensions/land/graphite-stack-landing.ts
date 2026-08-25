import { type BoundaryValue, isBoolean, isString } from "../shared/validation.ts";
/** Verified, parent-owned native Graphite stack landing. */

import { createHash } from "node:crypto";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { getPullRequest, waitForMerge } from "../shared/github.ts";
import { asRecord } from "../shared/narrow.ts";
import { type acquirePublicationLock, acquireRepositoryPublicationLock } from "../shared/publication-lock.ts";
import { verifyGraphiteDryRunAffectedRefs } from "../shared/vcs/graphite-dry-run.ts";
import { readinessBlockers } from "./orchestrator.ts";
import { blockedLandResult } from "./result.ts";
import type { FrontierResult, LandOptions, LandResult } from "./types.ts";

const MAX_REFS = 50;
const SHA_RE = /^[0-9a-f]{40}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

interface GraphitePullRequest {
	number: number;
	url: string;
	ref: string;
	baseRef: string;
	headSha: string;
	draft: boolean;
}

interface GraphiteLandingPlan {
	planId: string;
	repositoryRoot: string;
	trunkRef: string;
	selectedRef: string;
	pullRequests: readonly GraphitePullRequest[];
	preview: string;
}

export type GraphiteLandingResponse = { status: "not-stack" } | { status: "stack"; outcome: LandResult };

interface GraphiteLandingDeps {
	exec: ExecFn;
	cwd: string;
	signal: AbortSignal;
	runAutopilot(
		mode: "check" | "watch",
		pr: number,
	): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }>;
	confirmMerge(preview: string): Promise<boolean>;
	now(): number;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	acquireLock?: typeof acquirePublicationLock;
	realpath?: (path: string) => string;
	waitForMerge?: typeof waitForMerge;
}

function diagnostic(result: ExecFnResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

function safeRef(value: BoundaryValue): value is string {
	return (
		isString(value) &&
		value.length > 0 &&
		value.length <= 240 &&
		REF_RE.test(value) &&
		!value.includes("..") &&
		!value.includes("//") &&
		!value.endsWith(".lock")
	);
}

async function run(
	exec: ExecFn,
	command: string,
	args: string[],
	cwd: string,
	signal: AbortSignal,
	timeout = 15_000,
): Promise<ExecFnResult> {
	try {
		return await exec(command, args, { cwd, timeout, signal });
	} catch (error) {
		return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function parseOpenPullRequests(raw: string): GraphitePullRequest[] | undefined {
	let value: BoundaryValue;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > MAX_REFS) return undefined;
	const result: GraphitePullRequest[] = [];
	for (const candidate of value) {
		const item = asRecord(candidate);
		if (
			!item ||
			!Number.isSafeInteger(item.number) ||
			Number(item.number) <= 0 ||
			!isString(item.url) ||
			!safeRef(item.headRefName) ||
			!safeRef(item.baseRefName) ||
			!SHA_RE.test(String(item.headRefOid)) ||
			!isBoolean(item.isDraft)
		)
			return undefined;
		result.push({
			number: Number(item.number),
			url: item.url,
			ref: item.headRefName,
			baseRef: item.baseRefName,
			headSha: String(item.headRefOid),
			draft: item.isDraft,
		});
	}
	return result;
}

async function queryOpenPullRequests(
	exec: ExecFn,
	cwd: string,
	filter: ["--head" | "--base", string],
	limit: number,
	signal: AbortSignal,
): Promise<{ ok: true; pullRequests: GraphitePullRequest[] } | { ok: false; error: string }> {
	const listed = await run(
		exec,
		"gh",
		[
			"pr",
			"list",
			"--state",
			"open",
			...filter,
			"--limit",
			String(limit),
			"--json",
			"number,url,headRefName,baseRefName,headRefOid,isDraft",
		],
		cwd,
		signal,
	);
	if (listed.code !== 0) return { ok: false, error: `Could not inspect open PR topology: ${diagnostic(listed)}` };
	const pullRequests = parseOpenPullRequests(listed.stdout);
	return pullRequests
		? { ok: true, pullRequests }
		: { ok: false, error: "GitHub returned invalid Graphite PR topology." };
}

async function inspectPlan(
	cwd: string,
	targetPr: number,
	exec: ExecFn,
	signal: AbortSignal,
): Promise<{ ok: true; plan?: GraphiteLandingPlan } | { ok: false; error: string }> {
	const root = await run(exec, "git", ["rev-parse", "--show-toplevel"], cwd, signal);
	const repositoryRoot = root.stdout.trim();
	if (root.code !== 0 || !repositoryRoot)
		return { ok: false, error: `Could not resolve the Git root: ${diagnostic(root)}` };
	const trunk = await run(exec, "gt", ["--no-interactive", "trunk"], repositoryRoot, signal);
	const trunkRef = trunk.stdout.trim();
	if (trunk.code !== 0 || !safeRef(trunkRef))
		return { ok: false, error: `Could not resolve the Graphite trunk: ${diagnostic(trunk)}` };
	const target = await getPullRequest(exec, repositoryRoot, targetPr, signal);
	if (target.state !== "OPEN") return { ok: false, error: `PR #${targetPr} is ${target.state.toLowerCase()}.` };
	if (!safeRef(target.headRef) || !safeRef(target.baseRef)) {
		return { ok: false, error: `PR #${targetPr} has invalid Graphite head/base refs.` };
	}
	const selected: GraphitePullRequest = {
		number: target.number,
		url: target.url,
		ref: target.headRef,
		baseRef: target.baseRef,
		headSha: target.headOid,
		draft: target.isDraft,
	};

	const prefix = [selected];
	const seen = new Set([selected.ref]);
	while (prefix[0].baseRef !== trunkRef) {
		if (prefix.length >= MAX_REFS) return { ok: false, error: "Graphite PR topology is too large." };
		const parents = await queryOpenPullRequests(exec, repositoryRoot, ["--head", prefix[0].baseRef], 2, signal);
		if (!parents.ok) return parents;
		if (parents.pullRequests.length !== 1) {
			return {
				ok: false,
				error: `Graphite prefix for ${selected.ref} expected one open PR with head ${prefix[0].baseRef}; found ${parents.pullRequests.length}.`,
			};
		}
		const parent = parents.pullRequests[0];
		if (seen.has(parent.ref)) return { ok: false, error: "Graphite PR topology is cyclic." };
		seen.add(parent.ref);
		prefix.unshift(parent);
	}
	const children = await queryOpenPullRequests(exec, repositoryRoot, ["--base", selected.ref], 1, signal);
	if (!children.ok) return children;
	const hasChild = children.pullRequests.length > 0;
	const current = await run(exec, "git", ["branch", "--show-current"], repositoryRoot, signal);
	if (current.code !== 0 || current.stdout.trim() !== selected.ref) {
		if (prefix.length === 1 && !hasChild) {
			return {
				ok: false,
				error: `Graphite landing requires selected branch ${selected.ref} to be checked out before proving it has no unpublished descendants.`,
			};
		}
		return { ok: false, error: `Graphite stack landing requires selected branch ${selected.ref} to be checked out.` };
	}
	if (prefix.length === 1 && !hasChild) {
		const localChildren = await run(exec, "gt", ["--no-interactive", "children"], repositoryRoot, signal, 8_000);
		if (localChildren.code !== 0) {
			return { ok: false, error: `Could not inspect local Graphite descendants: ${diagnostic(localChildren)}` };
		}
		if (!localChildren.stdout.trim()) return { ok: true };
	}
	for (const pr of prefix) {
		const local = await run(
			exec,
			"git",
			["rev-parse", "--verify", `refs/heads/${pr.ref}^{commit}`],
			repositoryRoot,
			signal,
		);
		if (local.code !== 0 || local.stdout.trim() !== pr.headSha) {
			return {
				ok: false,
				error: `Local Graphite branch ${pr.ref} does not match PR #${pr.number} head ${pr.headSha}.`,
			};
		}
	}
	const facts = prefix.map((pr) => ({
		number: pr.number,
		ref: pr.ref,
		baseRef: pr.baseRef,
		headSha: pr.headSha,
		draft: pr.draft,
	}));
	const planId = createHash("sha256").update(JSON.stringify({ repositoryRoot, trunkRef, facts })).digest("hex");
	const preview = [
		`Graphite stack landing ${planId.slice(0, 16)}`,
		...prefix.map((pr) => `- PR #${pr.number}: ${pr.ref} -> ${pr.baseRef} @ ${pr.headSha.slice(0, 12)}`),
		"Graphite will use the merge method and merge-queue policy configured for this repository.",
		"After every PR is verified merged, Kstack will run gt sync to clean up Graphite's local stack.",
	].join("\n");
	return {
		ok: true,
		plan: { planId, repositoryRoot, trunkRef, selectedRef: selected.ref, pullRequests: prefix, preview },
	};
}

async function dryRun(
	plan: GraphiteLandingPlan,
	deps: GraphiteLandingDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const result = await run(
		deps.exec,
		"gt",
		["--no-interactive", "merge", "--dry-run"],
		plan.repositoryRoot,
		deps.signal,
		60_000,
	);
	if (result.code !== 0) return { ok: false, error: `gt merge --dry-run failed: ${diagnostic(result)}` };
	const scope = verifyGraphiteDryRunAffectedRefs(
		`${result.stdout}\n${result.stderr}`,
		"merge",
		plan.pullRequests.map((pr) => pr.ref).reverse(),
	);
	return scope.ok ? { ok: true } : { ok: false, error: `Refusing Graphite stack landing: ${scope.error}` };
}

export async function requestGraphiteStackLanding(
	options: LandOptions,
	deps: GraphiteLandingDeps,
): Promise<GraphiteLandingResponse> {
	let inspected: Awaited<ReturnType<typeof inspectPlan>>;
	try {
		inspected = await inspectPlan(deps.cwd, options.target.prNumber, deps.exec, deps.signal);
	} catch (error) {
		return { status: "stack", outcome: blockedLandResult(error instanceof Error ? error.message : String(error)) };
	}
	if (!inspected.ok) return { status: "stack", outcome: blockedLandResult(inspected.error) };
	if (!inspected.plan) return { status: "not-stack" };
	if (options.method) {
		return {
			status: "stack",
			outcome: blockedLandResult(
				"--method is not supported for Graphite stack landing; Graphite repository settings own the merge method.",
			),
		};
	}

	let plan = inspected.plan;
	const readinessEvidence = new Map<number, { ref: string; baseRef: string; headSha: string }>();
	for (const pr of plan.pullRequests) {
		const readiness = await deps.runAutopilot(options.readiness, pr.number);
		if (!readiness.handled)
			return { status: "stack", outcome: blockedLandResult("pr-autopilot extension is unavailable.") };
		const result = readiness.outcome;
		if (
			result.status !== "merge-ready" ||
			!result.mergeReady ||
			!result.prState ||
			result.prState.verifiedHeadSha !== result.prState.headSha ||
			result.prState.number !== pr.number ||
			result.prState.headRef !== pr.ref ||
			result.prState.baseRef !== pr.baseRef
		) {
			const blockers = readinessBlockers({ readiness: options.readiness, prNumber: pr.number }, result);
			return {
				status: "stack",
				outcome: {
					...blockedLandResult(
						`PR #${pr.number} is not exact-head merge-ready: ${blockers.join("; ") || result.status}.`,
					),
					autopilotRan: true,
					autopilotStatus: result.status,
				},
			};
		}
		readinessEvidence.set(pr.number, {
			ref: result.prState.headRef,
			baseRef: result.prState.baseRef,
			headSha: result.prState.headSha,
		});
	}

	const refreshed = await inspectPlan(deps.cwd, options.target.prNumber, deps.exec, deps.signal);
	if (!refreshed.ok || !refreshed.plan)
		return {
			status: "stack",
			outcome: blockedLandResult(
				refreshed.ok ? "Graphite stack topology disappeared after readiness checks." : refreshed.error,
			),
		};
	const refreshedPlan = refreshed.plan;
	const readinessChanged =
		refreshedPlan.pullRequests.length !== readinessEvidence.size ||
		refreshedPlan.pullRequests.some((pr) => {
			const evidence = readinessEvidence.get(pr.number);
			return !evidence || evidence.ref !== pr.ref || evidence.baseRef !== pr.baseRef || evidence.headSha !== pr.headSha;
		});
	if (readinessChanged) {
		return {
			status: "stack",
			outcome: {
				...blockedLandResult("Graphite PR heads or topology changed after readiness checks; no merge ran."),
				autopilotRan: true,
			},
		};
	}
	plan = refreshedPlan;
	if (plan.pullRequests.some((pr) => pr.draft))
		return {
			status: "stack",
			outcome: blockedLandResult("Every Graphite prefix PR must be ready for review before landing."),
		};
	const previewDryRun = await dryRun(plan, deps);
	if (!previewDryRun.ok) return { status: "stack", outcome: blockedLandResult(previewDryRun.error) };
	if (!(await deps.confirmMerge(plan.preview))) {
		return {
			status: "stack",
			outcome: {
				...blockedLandResult("Graphite stack landing confirmation declined."),
				status: "declined",
				autopilotRan: true,
			},
		};
	}

	const lock = await acquireRepositoryPublicationLock(deps.exec, plan.repositoryRoot, {
		acquireLock: deps.acquireLock,
		realpath: deps.realpath,
		signal: deps.signal,
	});
	if (!lock.ok) {
		const reason =
			lock.kind === "busy" ? "Another Graphite publication or landing is active for this repository." : lock.error;
		return { status: "stack", outcome: blockedLandResult(reason) };
	}
	try {
		const final = await inspectPlan(deps.cwd, options.target.prNumber, deps.exec, deps.signal);
		if (!final.ok || !final.plan || final.plan.planId !== plan.planId) {
			return {
				status: "stack",
				outcome: blockedLandResult(
					final.ok ? "Graphite landing plan changed after confirmation; no merge ran." : final.error,
				),
			};
		}
		const finalPlan = final.plan;
		const finalDryRun = await dryRun(finalPlan, deps);
		if (!finalDryRun.ok) return { status: "stack", outcome: blockedLandResult(finalDryRun.error) };

		let merged: ExecFnResult;
		try {
			merged = await deps.exec("gt", ["--no-interactive", "merge"], {
				cwd: finalPlan.repositoryRoot,
				timeout: 60_000,
				signal: deps.signal,
			});
		} catch (error) {
			return {
				status: "stack",
				outcome: {
					...blockedLandResult(
						`gt merge may have started before the process failed: ${error instanceof Error ? error.message : String(error)}. Inspect ${finalPlan.pullRequests.map((pr) => `#${pr.number}`).join(", ")} before retrying.`,
					),
					status: "partially-landed",
					autopilotRan: true,
				},
			};
		}
		if (merged.code !== 0) {
			return {
				status: "stack",
				outcome: {
					...blockedLandResult(
						`gt merge returned ${diagnostic(merged)} after invocation. Inspect ${finalPlan.pullRequests.map((pr) => `#${pr.number}`).join(", ")} before retrying.`,
					),
					status: "partially-landed",
					autopilotRan: true,
				},
			};
		}

		const waiter = deps.waitForMerge ?? waitForMerge;
		const settlements = await Promise.allSettled(
			finalPlan.pullRequests.map((pr) =>
				waiter(deps.exec, finalPlan.repositoryRoot, pr.number, pr.ref, pr.headSha, deps, deps.signal),
			),
		);
		const frontiers: FrontierResult[] = [];
		const completedMutations = [
			`Graphite accepted the native merge for ${finalPlan.pullRequests.map((pr) => `#${pr.number}`).join(", ")}`,
		];
		const blockers: string[] = [];
		const warnings: string[] = [];
		let allMerged = true;
		for (let index = 0; index < settlements.length; index++) {
			const pr = finalPlan.pullRequests[index];
			const settlement = settlements[index];
			let state: FrontierResult["state"];
			if (settlement.status === "rejected") {
				allMerged = false;
				state = "blocked";
				const error = settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason);
				blockers.push(`PR #${pr.number} remote verification failed: ${error}. Inspect it before retrying.`);
			} else if (settlement.value.merged) {
				state = "landed";
				completedMutations.push(`Verified PR #${pr.number} merged remotely`);
			} else {
				allMerged = false;
				const snapshot = settlement.value.snapshot;
				const unchangedOpen =
					snapshot.state === "OPEN" && snapshot.headRef === pr.ref && snapshot.headOid === pr.headSha;
				if (unchangedOpen) {
					state = "queued";
					blockers.push(`PR #${pr.number} remains open at the expected head and may be queued.`);
				} else {
					state = "blocked";
					blockers.push(
						`PR #${pr.number} verification stopped at ${snapshot.state} ${snapshot.headRef}@${snapshot.headOid.slice(0, 12)}; expected OPEN or MERGED ${pr.ref}@${pr.headSha.slice(0, 12)}.`,
					);
				}
			}
			frontiers.push({
				prNumber: pr.number,
				url: pr.url,
				expectedHeadSha: pr.headSha,
				method: "graphite",
				state,
			});
		}
		if (allMerged) {
			const synced = await run(
				deps.exec,
				"gt",
				["--no-interactive", "sync"],
				finalPlan.repositoryRoot,
				deps.signal,
				60_000,
			);
			if (synced.code === 0) {
				completedMutations.push("Synchronized Graphite after the stack merged");
			} else {
				warnings.push(`The stack merged, but gt sync failed: ${diagnostic(synced)}. Run gt sync manually.`);
			}
		}
		return {
			status: "stack",
			outcome: {
				status: allMerged ? "landed" : "partially-landed",
				frontiers,
				autopilotRan: true,
				remainingRefs: [],
				completedMutations,
				warnings,
				blockers,
			},
		};
	} finally {
		lock.lock.release();
	}
}
