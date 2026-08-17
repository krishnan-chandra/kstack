/** Verified, parent-owned native Graphite stack landing. */

import { createHash } from "node:crypto";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";
import { getPullRequest, waitForMerge } from "../shared/github.ts";
import { asRecord } from "../shared/narrow.ts";
import { acquirePublicationLock } from "../shared/publication-lock.ts";
import type { LandOptions, LandResult } from "./types.ts";

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
	waitForMerge?: typeof waitForMerge;
}

function diagnostic(result: ExecFnResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
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

function safeRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
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
	let value: unknown;
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
			typeof item.url !== "string" ||
			!safeRef(item.headRefName) ||
			!safeRef(item.baseRefName) ||
			!SHA_RE.test(String(item.headRefOid)) ||
			typeof item.isDraft !== "boolean"
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
	if (prefix.length === 1 && !hasChild) return { ok: true };

	const current = await run(exec, "git", ["branch", "--show-current"], repositoryRoot, signal);
	if (current.code !== 0 || current.stdout.trim() !== selected.ref) {
		return { ok: false, error: `Graphite stack landing requires selected branch ${selected.ref} to be checked out.` };
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
		"Kstack will not run gt sync or delete local branches afterward.",
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
	return result.code === 0 ? { ok: true } : { ok: false, error: `gt merge --dry-run failed: ${diagnostic(result)}` };
}

export async function requestGraphiteStackLanding(
	options: LandOptions,
	deps: GraphiteLandingDeps,
): Promise<GraphiteLandingResponse> {
	let inspected: Awaited<ReturnType<typeof inspectPlan>>;
	try {
		inspected = await inspectPlan(deps.cwd, options.target.prNumber, deps.exec, deps.signal);
	} catch (error) {
		return { status: "stack", outcome: blocked(error instanceof Error ? error.message : String(error)) };
	}
	if (!inspected.ok) return { status: "stack", outcome: blocked(inspected.error) };
	if (!inspected.plan) return { status: "not-stack" };
	if (options.method) {
		return {
			status: "stack",
			outcome: blocked(
				"--method is not supported for Graphite stack landing; Graphite repository settings own the merge method.",
			),
		};
	}

	let plan = inspected.plan;
	for (const pr of plan.pullRequests) {
		const readiness = await deps.runAutopilot(options.readiness, pr.number);
		if (!readiness.handled) return { status: "stack", outcome: blocked("pr-autopilot extension is unavailable.") };
		const result = readiness.outcome;
		if (
			result.status !== "merge-ready" ||
			!result.mergeReady ||
			!result.prState ||
			result.prState.verifiedHeadSha !== result.prState.headSha ||
			result.prState.number !== pr.number ||
			result.prState.headRef !== pr.ref ||
			result.prState.headSha !== pr.headSha
		) {
			return {
				status: "stack",
				outcome: {
					...blocked(
						`PR #${pr.number} is not exact-head merge-ready: ${result.blockedReasons.join("; ") || result.status}.`,
					),
					autopilotRan: true,
					autopilotStatus: result.status,
				},
			};
		}
	}

	const refreshed = await inspectPlan(deps.cwd, options.target.prNumber, deps.exec, deps.signal);
	if (!refreshed.ok || !refreshed.plan)
		return {
			status: "stack",
			outcome: blocked(refreshed.ok ? "Graphite stack topology disappeared after readiness checks." : refreshed.error),
		};
	plan = refreshed.plan;
	if (plan.pullRequests.some((pr) => pr.draft))
		return { status: "stack", outcome: blocked("Every Graphite prefix PR must be ready for review before landing.") };
	const previewDryRun = await dryRun(plan, deps);
	if (!previewDryRun.ok) return { status: "stack", outcome: blocked(previewDryRun.error) };
	if (!(await deps.confirmMerge(plan.preview))) {
		return {
			status: "stack",
			outcome: { ...blocked("Graphite stack landing confirmation declined."), status: "declined", autopilotRan: true },
		};
	}

	const lock = (deps.acquireLock ?? acquirePublicationLock)({ repositoryPath: plan.repositoryRoot });
	if (!lock.ok)
		return { status: "stack", outcome: blocked("Another stack publication or landing is active for this repository.") };
	try {
		const final = await inspectPlan(deps.cwd, options.target.prNumber, deps.exec, deps.signal);
		if (!final.ok || !final.plan || final.plan.planId !== plan.planId) {
			return {
				status: "stack",
				outcome: blocked(final.ok ? "Graphite landing plan changed after confirmation; no merge ran." : final.error),
			};
		}
		const finalPlan = final.plan;
		const finalDryRun = await dryRun(finalPlan, deps);
		if (!finalDryRun.ok) return { status: "stack", outcome: blocked(finalDryRun.error) };

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
					...blocked(
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
					...blocked(
						`gt merge returned ${diagnostic(merged)} after invocation. Inspect ${finalPlan.pullRequests.map((pr) => `#${pr.number}`).join(", ")} before retrying.`,
					),
					status: "partially-landed",
					autopilotRan: true,
				},
			};
		}

		const waiter = deps.waitForMerge ?? waitForMerge;
		let results: Array<{ pr: GraphitePullRequest; verified: Awaited<ReturnType<typeof waitForMerge>> }>;
		try {
			results = await Promise.all(
				finalPlan.pullRequests.map(async (pr) => ({
					pr,
					verified: await waiter(deps.exec, finalPlan.repositoryRoot, pr.number, pr.ref, pr.headSha, deps, deps.signal),
				})),
			);
		} catch (error) {
			return {
				status: "stack",
				outcome: {
					status: "partially-landed",
					frontiers: finalPlan.pullRequests.map((pr) => ({
						prNumber: pr.number,
						url: pr.url,
						expectedHeadSha: pr.headSha,
						method: "graphite",
						state: "queued",
					})),
					autopilotRan: true,
					remainingBookmarks: [],
					completedMutations: [
						`Graphite accepted the native merge for ${finalPlan.pullRequests.map((pr) => `#${pr.number}`).join(", ")}`,
					],
					blockers: [
						`Remote verification failed after Graphite accepted the merge: ${error instanceof Error ? error.message : String(error)}. Inspect the listed PRs; do not blindly retry.`,
					],
				},
			};
		}
		const frontiers = results.map(({ pr, verified }) => ({
			prNumber: pr.number,
			url: pr.url,
			expectedHeadSha: pr.headSha,
			method: "graphite" as const,
			state: verified.merged ? ("landed" as const) : ("queued" as const),
		}));
		const allMerged = results.every((item) => item.verified.merged);
		return {
			status: "stack",
			outcome: {
				status: allMerged ? "landed" : "partially-landed",
				frontiers,
				autopilotRan: true,
				remainingBookmarks: [],
				completedMutations: [
					`Graphite accepted the native merge for ${finalPlan.pullRequests.map((pr) => `#${pr.number}`).join(", ")}`,
					...results
						.filter((item) => item.verified.merged)
						.map((item) => `Verified PR #${item.pr.number} merged remotely`),
				],
				blockers: allMerged
					? []
					: [
							"Graphite accepted the merge, but not every exact PR reached verified MERGED state. Inspect the listed PRs; do not blindly retry.",
						],
			},
		};
	} finally {
		lock.lock.release();
	}
}
