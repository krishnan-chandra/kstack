/** Bottom-up Git landing loop for navigation-comment stacks. */

import type { LandResult } from "../land/types.ts";
import { commandDiagnostic, type ExecFn, runCommand } from "../shared/git-exec.ts";
import {
	type GitHubGateway,
	type GitHubRepository,
	isGitHubIndeterminate,
	type MergeMethod,
	type OpenPullRequest,
} from "../shared/github.ts";
import { type acquirePublicationLock, acquireRepositoryPublicationLock } from "../shared/publication-lock.ts";
import { STACK_SHA_RE } from "../shared/stack/manifest.ts";
import type { StackLandFrontier, StackLandOutcome, StackPrefixLandOutcome } from "../shared/stack/outcome.ts";
import { createNavigationCommentStore, type NavigationEntry } from "../shared/stack/topology.ts";
import type { BoundaryValue } from "../shared/validation.ts";
import { requireGit238, resolveGitRemote, resolveGitTrunk } from "./repository.ts";

interface LocalStackEntry {
	entry: NavigationEntry & { prNumber: number };
	pr: OpenPullRequest;
	status: "open" | "draft" | "merged" | "closed" | "unknown";
	localSha: string | undefined;
}

interface GitHubLandingDeps {
	exec: ExecFn;
	gateway: GitHubGateway;
	confirm(title: string, body: string): Promise<boolean>;
	selectMethod(allowed: readonly MergeMethod[]): Promise<MergeMethod | undefined>;
	landFrontier(input: {
		prNumber: number;
		expectedHeadSha: string;
		readiness: "check" | "watch";
		method: MergeMethod;
	}): Promise<{ handled: false } | { handled: true; outcome: LandResult }>;
	signal?: AbortSignal;
	acquireLock?: typeof acquirePublicationLock;
	realpath?: (path: string) => string;
}

export async function requestGitHubStackLanding(
	input: {
		cwd: string;
		prNumber: number;
		headRef: string;
		readiness: "check" | "watch";
		method?: MergeMethod;
		remote?: string;
	},
	deps: GitHubLandingDeps,
): Promise<StackPrefixLandOutcome> {
	const remote = input.remote
		? await resolveGitRemote(input.cwd, input.remote, deps.exec, deps.signal)
		: await discoverLandingRemote(input.cwd, input.prNumber, input.headRef, deps);
	if (!remote.ok) return stackBlocked(remote.error);
	const remoteName = remote.remote.name;
	let membership: { entries: NavigationEntry[]; selectedIndex: number };
	try {
		membership = await createNavigationCommentStore(deps.gateway).membership({
			repo: remote.remote.repository,
			prNumber: input.prNumber,
			headRef: input.headRef,
			cwd: input.cwd,
			signal: deps.signal,
		});
	} catch (error) {
		return stackBlocked(`Could not inspect the selected PR: ${errorMessage(error)}`);
	}
	if (membership.selectedIndex < 0 || membership.entries.length <= 1) return { status: "not-stack" };
	const version = await requireGit238(input.cwd, deps.exec);
	if (!version.ok) return stackBlocked(version.error);
	const clean = await runCommand(
		deps.exec,
		"git",
		["status", "--porcelain=v1", "--untracked-files=all"],
		input.cwd,
		deps.signal,
	);
	if (clean.code !== 0 || clean.stdout.trim())
		return stackBlocked("GitHub stack landing requires a clean working tree.");
	const prepared = await inspectLocalStack(
		membership.entries,
		membership.selectedIndex,
		remote.remote.repository,
		input.cwd,
		deps,
	);
	if (!prepared.ok) return stackBlocked(prepared.error);
	const method = await resolveMethod(input.method, remote.remote.repository, input.cwd, deps);
	if (!method.ok) return stackBlocked(method.error);
	const preview = renderPreview(prepared.entries, membership.selectedIndex, method.method, input.readiness);
	if (!preview.ok) return stackBlocked(preview.error);
	if (!(await deps.confirm("Land this GitHub stack prefix?", preview.body))) {
		return { status: "stack", outcome: { status: "declined" } };
	}
	const outcome = await runLandingLoop({
		cwd: input.cwd,
		remote: remoteName,
		repository: remote.remote.repository,
		selectedIndex: membership.selectedIndex,
		entries: prepared.entries,
		method: method.method,
		readiness: input.readiness,
		deps,
	});
	return { status: "stack", outcome };
}

async function discoverLandingRemote(
	cwd: string,
	prNumber: number,
	headRef: string,
	deps: GitHubLandingDeps,
): Promise<Awaited<ReturnType<typeof resolveGitRemote>>> {
	const listed = await runCommand(deps.exec, "git", ["remote"], cwd, deps.signal);
	if (listed.code !== 0) return { ok: false, error: `Could not list Git remotes: ${commandDiagnostic(listed)}` };
	const candidates: Array<{ name: string; repository: GitHubRepository }> = [];
	const inspectionErrors: string[] = [];
	for (const name of listed.stdout.split(/\r?\n/).filter(Boolean)) {
		const remote = await resolveGitRemote(cwd, name, deps.exec, deps.signal);
		if (!remote.ok) continue;
		try {
			const matches = await deps.gateway.listPrsForHead(remote.remote.repository, headRef, cwd, deps.signal);
			if (matches.some((pr) => pr.number === prNumber)) candidates.push(remote.remote);
		} catch (error) {
			inspectionErrors.push(`${name}: ${errorMessage(error)}`);
		}
	}
	const byRepository = new Map<string, Array<(typeof candidates)[number]>>();
	for (const candidate of candidates) {
		const key = `${candidate.repository.owner}/${candidate.repository.repo}`.toLowerCase();
		const aliases = byRepository.get(key) ?? [];
		aliases.push(candidate);
		byRepository.set(key, aliases);
	}
	if (byRepository.size === 1) {
		const aliases = [...byRepository.values()][0];
		const selected = aliases.find((candidate) => candidate.name === "origin") ?? aliases[0];
		return { ok: true, remote: selected };
	}
	if (byRepository.size > 1) {
		return {
			ok: false,
			error: `PR #${prNumber} and branch ${headRef} match multiple GitHub repositories: ${[...byRepository.keys()].join(", ")}.`,
		};
	}
	const diagnostic = inspectionErrors.length > 0 ? ` Remote inspection failed: ${inspectionErrors.join("; ")}.` : "";
	return {
		ok: false,
		error: `Could not map PR #${prNumber} and branch ${headRef} to a GitHub remote.${diagnostic}`,
	};
}

async function inspectLocalStack(
	entries: readonly NavigationEntry[],
	selectedIndex: number,
	repository: GitHubRepository,
	cwd: string,
	deps: GitHubLandingDeps,
): Promise<{ ok: true; entries: LocalStackEntry[] } | { ok: false; error: string }> {
	if (entries.length === 0 || selectedIndex >= entries.length)
		return { ok: false, error: "Navigation metadata is incomplete." };
	let openPrs: OpenPullRequest[];
	try {
		openPrs = await deps.gateway.listOpenPrs(repository, cwd, deps.signal);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
	const inspected: LocalStackEntry[] = [];
	for (const [index, entry] of entries.entries()) {
		if (entry.prNumber === undefined) return { ok: false, error: `Stack ref ${entry.bookmark} has no PR number.` };
		let status: LocalStackEntry["status"];
		try {
			status = await deps.gateway.getPrStatus(repository, entry.prNumber, cwd, deps.signal);
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
		let prs = openPrs.filter((pr) => pr.headRef === entry.bookmark);
		if (status === "merged") {
			try {
				prs = await deps.gateway.listPrsForHead(repository, entry.bookmark, cwd, deps.signal);
			} catch (error) {
				return { ok: false, error: errorMessage(error) };
			}
		}
		if (prs.length !== 1 || prs[0].number !== entry.prNumber) {
			return { ok: false, error: `Could not resolve exactly one PR for ${entry.bookmark}.` };
		}
		const local = await runCommand(
			deps.exec,
			"git",
			["rev-parse", "--verify", `refs/heads/${entry.bookmark}^{commit}`],
			cwd,
			deps.signal,
		);
		const localSha = local.code === 0 && STACK_SHA_RE.test(local.stdout.trim()) ? local.stdout.trim() : undefined;
		const requiredLocally = status !== "merged" || index > selectedIndex;
		if (requiredLocally && !localSha)
			return { ok: false, error: `Local branch ${entry.bookmark} is required to land this stack.` };
		if (status !== "merged" && localSha !== prs[0].headCommitId) {
			return {
				ok: false,
				error: `Local branch ${entry.bookmark} at ${localSha ?? "missing"} does not match PR #${entry.prNumber} head ${prs[0].headCommitId}.`,
			};
		}
		if (prs[0].baseRef !== entry.base) {
			return {
				ok: false,
				error: `PR #${entry.prNumber} base ${prs[0].baseRef} does not match stack base ${entry.base}.`,
			};
		}
		const previous = inspected.at(-1);
		if (previous?.localSha && localSha) {
			const ancestor = await runCommand(
				deps.exec,
				"git",
				["merge-base", "--is-ancestor", previous.localSha, localSha],
				cwd,
				deps.signal,
			);
			if (ancestor.code !== 0)
				return { ok: false, error: `Local branch ${entry.bookmark} is not based on ${previous.entry.bookmark}.` };
		}
		if (status === "closed" || status === "unknown") {
			return { ok: false, error: `PR #${entry.prNumber} for ${entry.bookmark} is ${status}.` };
		}
		inspected.push({ entry: { ...entry, prNumber: entry.prNumber }, pr: prs[0], status, localSha });
	}
	return { ok: true, entries: inspected };
}

async function resolveMethod(
	requested: MergeMethod | undefined,
	repository: GitHubRepository,
	cwd: string,
	deps: GitHubLandingDeps,
): Promise<{ ok: true; method: MergeMethod } | { ok: false; error: string }> {
	let allowed: MergeMethod[];
	try {
		allowed = await deps.gateway.getAllowedMergeMethods(repository, cwd, deps.signal);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
	if (requested) {
		return allowed.includes(requested)
			? { ok: true, method: requested }
			: { ok: false, error: `Merge method ${requested} is not enabled for ${repository.owner}/${repository.repo}.` };
	}
	if (allowed.length === 1) return { ok: true, method: allowed[0] };
	const selected = await deps.selectMethod(allowed);
	return selected
		? { ok: true, method: selected }
		: { ok: false, error: "No squash or rebase merge method was selected." };
}

function renderPreview(
	entries: readonly LocalStackEntry[],
	selectedIndex: number,
	method: MergeMethod,
	readiness: "check" | "watch",
): { ok: true; body: string } | { ok: false; error: string } {
	const lines = [
		`Method: ${method}`,
		`Readiness: ${readiness}`,
		...entries
			.slice(0, selectedIndex + 1)
			.map(
				(item) =>
					`- PR #${item.entry.prNumber}: ${item.entry.bookmark} -> ${item.pr.baseRef} @ ${item.pr.headCommitId}`,
			),
	];
	const body = lines.join("\n");
	return Buffer.byteLength(body, "utf8") <= 16 * 1024
		? { ok: true, body }
		: { ok: false, error: "The GitHub stack landing preview exceeds 16 KiB." };
}

async function verifyMergedFrontier(input: {
	current: LocalStackEntry;
	expectedHeadSha: string;
	cwd: string;
	repository: GitHubRepository;
	deps: GitHubLandingDeps;
}): Promise<{ ok: true; mergeCommitOid: string } | { ok: false; error: string }> {
	try {
		const merge = await input.deps.gateway.getMergeCommit(
			input.repository,
			input.current.entry.prNumber,
			input.cwd,
			input.deps.signal,
		);
		if (!merge.merged || !merge.mergeCommitOid || merge.headCommitId !== input.expectedHeadSha) {
			return {
				ok: false,
				error: `PR #${input.current.entry.prNumber} is not verified merged at ${input.expectedHeadSha}.`,
			};
		}
		return { ok: true, mergeCommitOid: merge.mergeCommitOid };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

interface AdvanceProgress {
	completedMutations: string[];
	warnings: string[];
}

type AdvanceResult =
	| ({ ok: true; trunkBranch: string } & AdvanceProgress)
	| ({ ok: false; error: string } & AdvanceProgress);

async function advanceRemainder(input: {
	current: LocalStackEntry;
	remainder: LocalStackEntry[];
	expectedHeadSha: string;
	mergeCommitOid: string;
	cwd: string;
	remote: string;
	repository: GitHubRepository;
	deps: GitHubLandingDeps;
}): Promise<AdvanceResult> {
	const progress: AdvanceProgress = { completedMutations: [], warnings: [] };
	const fetched = await runCommand(
		input.deps.exec,
		"git",
		["fetch", input.remote],
		input.cwd,
		input.deps.signal,
		60_000,
	);
	if (fetched.code !== 0) {
		return {
			ok: false,
			error: `Merged PR #${input.current.entry.prNumber}, but fetch failed: ${commandDiagnostic(fetched)}`,
			...progress,
		};
	}
	const remote = await resolveGitRemote(input.cwd, input.remote, input.deps.exec, input.deps.signal);
	if (!remote.ok) return { ok: false, error: remote.error, ...progress };
	const trunk = await resolveGitTrunk({
		cwd: input.cwd,
		remote: remote.remote,
		exec: input.deps.exec,
		gateway: input.deps.gateway,
		signal: input.deps.signal,
		fetch: false,
	});
	if (!trunk.ok) return { ok: false, error: trunk.error, ...progress };
	const mergedOnTrunk = await runCommand(
		input.deps.exec,
		"git",
		["merge-base", "--is-ancestor", input.mergeCommitOid, trunk.trunk.sha],
		input.cwd,
		input.deps.signal,
	);
	if (mergedOnTrunk.code !== 0) {
		return { ok: false, error: `Merge ${input.mergeCommitOid} is not on refreshed trunk.`, ...progress };
	}
	if (input.remainder.length === 0) {
		return { ok: true, trunkBranch: trunk.trunk.branch, ...progress };
	}
	const top = input.remainder.at(-1);
	if (!top) return { ok: false, error: "The landing remainder is unexpectedly empty.", ...progress };
	const rebased = await runCommand(
		input.deps.exec,
		"git",
		["rebase", "--onto", trunk.trunk.ref, input.expectedHeadSha, top.entry.bookmark, "--update-refs"],
		input.cwd,
		input.deps.signal,
		60_000,
	);
	if (rebased.code !== 0) {
		await runCommand(input.deps.exec, "git", ["rebase", "--abort"], input.cwd);
		return {
			ok: false,
			error: `Merged PR #${input.current.entry.prNumber}, but local rebase conflicted: ${commandDiagnostic(rebased)}`,
			...progress,
		};
	}
	const refreshed = await readRebasedHeads(input.remainder, input.cwd, input.deps);
	if (!refreshed.ok) return { ok: false, error: refreshed.error, ...progress };
	const pushed = await pushRemainderAtomically({
		remainder: input.remainder,
		newHeads: refreshed.heads,
		cwd: input.cwd,
		remote: input.remote,
		repository: input.repository,
		deps: input.deps,
	});
	if (!pushed.ok) return { ok: false, error: pushed.error, ...progress };
	for (const item of input.remainder) {
		const newSha = refreshed.heads.get(item.entry.bookmark);
		if (!newSha) return { ok: false, error: `Missing rebased head for ${item.entry.bookmark}.`, ...progress };
		item.localSha = newSha;
		item.pr = { ...item.pr, headCommitId: newSha };
		progress.completedMutations.push(`Pushed ${item.entry.bookmark}`);
	}
	const repaired = await repairRemainderBases(
		input.remainder,
		trunk.trunk.branch,
		input.cwd,
		input.repository,
		input.deps,
	);
	progress.completedMutations.push(...repaired.completedMutations);
	if (!repaired.ok) return { ok: false, error: repaired.error, ...progress };
	const comments = await createNavigationCommentStore(input.deps.gateway).reconcile({
		repo: input.repository,
		defaultBranch: trunk.trunk.branch,
		published: input.remainder.map((item, index) => ({
			ref: item.entry.bookmark,
			prNumber: item.entry.prNumber,
			targetBase: index === 0 ? trunk.trunk.branch : input.remainder[index - 1].entry.bookmark,
			createPr: false,
			draft: item.pr.draft,
		})),
		cwd: input.cwd,
		signal: input.deps.signal,
	});
	progress.warnings.push(...comments.errors);
	if (comments.indeterminate) progress.warnings.push(comments.indeterminate.error);
	return { ok: true, trunkBranch: trunk.trunk.branch, ...progress };
}

async function readRebasedHeads(
	remainder: readonly LocalStackEntry[],
	cwd: string,
	deps: GitHubLandingDeps,
): Promise<{ ok: true; heads: Map<string, string> } | { ok: false; error: string }> {
	const heads = new Map<string, string>();
	for (const item of remainder) {
		const refreshed = await runCommand(
			deps.exec,
			"git",
			["rev-parse", "--verify", `refs/heads/${item.entry.bookmark}^{commit}`],
			cwd,
			deps.signal,
		);
		const sha = refreshed.stdout.trim();
		if (refreshed.code !== 0 || !STACK_SHA_RE.test(sha) || !item.localSha) {
			return { ok: false, error: `Could not verify rebased branch ${item.entry.bookmark}.` };
		}
		heads.set(item.entry.bookmark, sha);
	}
	return { ok: true, heads };
}

async function pushRemainderAtomically(input: {
	remainder: readonly LocalStackEntry[];
	newHeads: ReadonlyMap<string, string>;
	cwd: string;
	remote: string;
	repository: GitHubRepository;
	deps: GitHubLandingDeps;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	for (const item of input.remainder) {
		try {
			const remoteSha = await input.deps.gateway.getRemoteBranchSha(
				input.repository,
				item.entry.bookmark,
				input.cwd,
				input.deps.signal,
			);
			if (remoteSha !== item.pr.headCommitId) {
				return {
					ok: false,
					error: `Remote branch ${item.entry.bookmark} moved from confirmed head ${item.pr.headCommitId} to ${remoteSha ?? "missing"}.`,
				};
			}
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}
	const leases = input.remainder.map(
		(item) => `--force-with-lease=refs/heads/${item.entry.bookmark}:${item.pr.headCommitId}`,
	);
	const refspecs: string[] = [];
	for (const item of input.remainder) {
		if (!input.newHeads.has(item.entry.bookmark)) {
			return { ok: false, error: `Missing rebased head for ${item.entry.bookmark}.` };
		}
		refspecs.push(`${item.entry.bookmark}:refs/heads/${item.entry.bookmark}`);
	}
	const pushed = await runCommand(
		input.deps.exec,
		"git",
		["push", "--atomic", ...leases, input.remote, ...refspecs],
		input.cwd,
		input.deps.signal,
		60_000,
	);
	return pushed.code === 0
		? { ok: true }
		: { ok: false, error: `Could not atomically republish the stack remainder: ${commandDiagnostic(pushed)}` };
}

type RepairResult =
	| { ok: true; completedMutations: string[] }
	| { ok: false; error: string; completedMutations: string[] };

async function repairRemainderBases(
	remainder: LocalStackEntry[],
	trunkBranch: string,
	cwd: string,
	repository: GitHubRepository,
	deps: GitHubLandingDeps,
): Promise<RepairResult> {
	const completedMutations: string[] = [];
	for (const [index, item] of remainder.entries()) {
		const targetBase = index === 0 ? trunkBranch : remainder[index - 1].entry.bookmark;
		if (item.pr.baseRef === targetBase) continue;
		try {
			await deps.gateway.updatePrBase({
				repo: repository,
				prNumber: item.entry.prNumber,
				base: targetBase,
				cwd,
				signal: deps.signal,
			});
			item.pr = { ...item.pr, baseRef: targetBase };
			completedMutations.push(`Repaired PR #${item.entry.prNumber} base → ${targetBase}`);
		} catch (error) {
			return { ok: false, error: errorMessage(error), completedMutations };
		}
	}
	return { ok: true, completedMutations };
}

async function cleanupMergedBranch(input: {
	current: LocalStackEntry;
	expectedHeadSha: string;
	trunkBranch: string;
	switchToTrunk: boolean;
	cwd: string;
	repository: GitHubRepository;
	deps: GitHubLandingDeps;
}): Promise<{ completedMutations: string[]; warnings: string[] }> {
	const completedMutations: string[] = [];
	const warnings: string[] = [];
	try {
		const remoteSha = await input.deps.gateway.getRemoteBranchSha(
			input.repository,
			input.current.entry.bookmark,
			input.cwd,
			input.deps.signal,
		);
		if (remoteSha === input.expectedHeadSha) {
			await input.deps.gateway.deleteRemoteBranch(
				input.repository,
				input.current.entry.bookmark,
				input.cwd,
				input.deps.signal,
			);
			completedMutations.push(`Deleted remote branch ${input.current.entry.bookmark}`);
		} else if (remoteSha !== undefined) {
			warnings.push(`Skipped deleting ${input.current.entry.bookmark}: remote head changed to ${remoteSha}.`);
		}
	} catch (error) {
		warnings.push(`Failed to delete remote branch ${input.current.entry.bookmark}: ${errorMessage(error)}`);
	}
	if (input.switchToTrunk) {
		const switched = await runCommand(
			input.deps.exec,
			"git",
			["switch", input.trunkBranch],
			input.cwd,
			input.deps.signal,
		);
		if (switched.code !== 0) {
			warnings.push(`Could not switch to trunk ${input.trunkBranch}: ${commandDiagnostic(switched)}`);
		}
	}
	const deletedLocal = await runCommand(
		input.deps.exec,
		"git",
		["branch", "-D", input.current.entry.bookmark],
		input.cwd,
		input.deps.signal,
	);
	if (deletedLocal.code !== 0) {
		warnings.push(`Failed to delete local branch ${input.current.entry.bookmark}: ${commandDiagnostic(deletedLocal)}`);
	}
	return { completedMutations, warnings };
}

async function runLandingLoop(input: {
	cwd: string;
	remote: string;
	repository: GitHubRepository;
	selectedIndex: number;
	entries: readonly LocalStackEntry[];
	method: MergeMethod;
	readiness: "check" | "watch";
	deps: GitHubLandingDeps;
}): Promise<StackLandOutcome> {
	const lock = await acquireRepositoryPublicationLock(input.deps.exec, input.cwd, {
		acquireLock: input.deps.acquireLock,
		realpath: input.deps.realpath,
		signal: input.deps.signal,
	});
	if (!lock.ok) {
		return lock.kind === "busy"
			? { status: "busy", message: "Another stack publication or landing is active for this repository." }
			: { status: "failed", error: lock.error };
	}
	const fresh = await inspectLocalStack(
		input.entries.map((item) => item.entry),
		input.selectedIndex,
		input.repository,
		input.cwd,
		input.deps,
	);
	if (!fresh.ok) {
		lock.lock.release();
		return { status: "blocked", blockers: [{ code: "github-land", message: fresh.error }] };
	}
	const changed = fresh.entries.some((item, index) => {
		const prior = input.entries[index];
		return (
			!prior ||
			item.status !== prior.status ||
			item.localSha !== prior.localSha ||
			item.pr.headCommitId !== prior.pr.headCommitId
		);
	});
	if (changed) {
		lock.lock.release();
		return {
			status: "blocked",
			blockers: [
				{
					code: "github-land",
					message: "The local or remote stack changed after confirmation; retry from a fresh plan.",
				},
			],
		};
	}
	const entries = fresh.entries;
	const frontiers: StackLandFrontier[] = [];
	const completedMutations: string[] = [];
	const warnings: string[] = [];
	const recoveryOperationIds: string[] = [];
	let remainingRefs = entries.map((item) => item.entry.bookmark);
	const progress = () => ({
		frontiers: [...frontiers],
		remainingRefs: [...remainingRefs],
		completedMutations: [...completedMutations],
		warnings: [...warnings],
		recoveryOperationIds: [...recoveryOperationIds],
	});
	try {
		for (let index = 0; index <= input.selectedIndex; index++) {
			const current = entries[index];
			if (input.deps.signal?.aborted) {
				return frontiers.length === 0 && completedMutations.length === 0
					? { status: "cancelled", ...progress() }
					: { status: "partial", error: "Landing was cancelled after earlier mutations completed.", ...progress() };
			}
			const expectedHeadSha = current.pr.headCommitId;
			const frontier: StackLandFrontier = {
				ref: current.entry.bookmark,
				prNumber: current.entry.prNumber,
				url: current.pr.url,
				expectedHeadSha,
				method: input.method,
				state: current.status === "merged" ? "already-merged" : "not-attempted",
			};
			if (current.status !== "merged") {
				const landed = await input.deps.landFrontier({
					prNumber: current.entry.prNumber,
					expectedHeadSha,
					readiness: input.readiness,
					method: input.method,
				});
				if (!landed.handled) {
					if (frontiers.length === 0)
						return {
							status: "blocked",
							blockers: [{ code: "land-unavailable", message: "The land extension is unavailable." }],
						};
					frontiers.push(frontier);
					return { status: "partial", error: "The land extension is unavailable.", ...progress() };
				}
				completedMutations.push(...landed.outcome.completedMutations);
				if (landed.outcome.status !== "landed") {
					frontier.state = landed.outcome.status === "partially-landed" ? "queued" : "blocked";
					frontiers.push(frontier);
					const hasProgress = frontiers.length > 1 || completedMutations.length > 0;
					return {
						status: landed.outcome.status === "failed" && !hasProgress ? "failed" : "partial",
						error: landed.outcome.blockers.join(" ") || `Land returned ${landed.outcome.status}.`,
						...progress(),
					};
				}
				frontier.state = "landed";
			}

			const verifiedMerge = await verifyMergedFrontier({
				current,
				expectedHeadSha,
				cwd: input.cwd,
				repository: input.repository,
				deps: input.deps,
			});
			if (!verifiedMerge.ok) {
				frontiers.push(frontier);
				return { status: "partial", error: verifiedMerge.error, ...progress() };
			}

			const remainder = entries.slice(index + 1);
			for (const item of remainder) {
				if (item.localSha) recoveryOperationIds.push(`${item.entry.bookmark}@${item.localSha}`);
			}
			const advanced = await advanceRemainder({
				current,
				remainder,
				expectedHeadSha,
				mergeCommitOid: verifiedMerge.mergeCommitOid,
				cwd: input.cwd,
				remote: input.remote,
				repository: input.repository,
				deps: input.deps,
			});
			completedMutations.push(...advanced.completedMutations);
			warnings.push(...advanced.warnings);
			if (!advanced.ok) {
				frontiers.push(frontier);
				return { status: "partial", error: advanced.error, ...progress() };
			}

			const cleanup = await cleanupMergedBranch({
				current,
				expectedHeadSha,
				trunkBranch: advanced.trunkBranch,
				switchToTrunk: remainder.length === 0,
				cwd: input.cwd,
				repository: input.repository,
				deps: input.deps,
			});
			completedMutations.push(...cleanup.completedMutations);
			warnings.push(...cleanup.warnings);
			frontiers.push(frontier);
			remainingRefs = entries.slice(index + 1).map((item) => item.entry.bookmark);
		}
		return { status: "completed", ...progress() };
	} catch (error) {
		if (isGitHubIndeterminate(error)) {
			return {
				status: "indeterminate",
				inFlight: errorMessage(error),
				recovery: "Inspect the frontier PR and remote stack state before retrying.",
				...progress(),
			};
		}
		return frontiers.length > 0 || completedMutations.length > 0
			? { status: "partial", error: errorMessage(error), ...progress() }
			: { status: "failed", error: errorMessage(error), ...progress() };
	} finally {
		lock.lock.release();
	}
}

function stackBlocked(message: string): StackPrefixLandOutcome {
	return { status: "stack", outcome: { status: "blocked", blockers: [{ code: "github-land", message }] } };
}

function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}
