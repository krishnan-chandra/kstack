/**
 * Bounded PR babysit state machine.
 *
 * One PR at a time, lowest unmerged first. Tiny models only — the config's
 * model set is the exclusive source of child agents, and every spawned child
 * uses a model drawn from that set. The loop:
 *
 *   check PR state → triage (tiny model) → fix (tiny model) → push → recheck
 *
 * Modes:
 *   check    — one status pass, report, stop.
 *   threads  — address review threads only, then push.
 *   drive    — loop until merge-ready (or a hard blocker).
 *   cleanup  — remove the managed worktree and branch after confirmation.
 *
 * Invariants enforced here:
 *   - Work the lowest unmerged PR first.
 *   - Resolve conflicts and threads before burning CI effort.
 *   - Classify failures before retrying; never retry blindly.
 *   - Pin verification to the exact head SHA; invalidate after a push.
 *   - Stop at merge-ready unless the user explicitly authorized merging.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { findLowestUnmergedPR, getCheckRuns, getReviewThreads, viewPR, type GHPrJson } from "./github.ts";
import { runAgent } from "./agent-runner.ts";
import { LIMITS, type BabysitAgentRole, type BabysitMode, type CheckRun, type ExecFn, type PRState, type ResolvedBabysitConfig, type ReviewThread, type UsageSummary } from "./types.ts";

/** Lifecycle phases surfaced to the parent UI for status display. */
export type LifecyclePhase = "idle" | "discovering" | "checking" | "triaging" | "fixing" | "pushing" | "rechecking" | "cleaning";

/** Outcome of a full babysit run. */
export interface BabysitResult {
	status: "merge-ready" | "blocked" | "incomplete" | "cleaned" | "aborted" | "failed";
	/** The final PR state snapshot. */
	prState?: PRState;
	/** Whether the PR reached merge-ready. */
	mergeReady: boolean;
	/** Cycles completed. */
	cyclesCompleted: number;
	/** What still needs human attention. */
	blockedReasons: string[];
	/** Model usage across all child agents. */
	usage: UsageSummary;
}

export interface PushResult {
	ok: boolean;
	headSha?: string;
	error?: string;
}

/**
 * Synthesize a PRState snapshot from GitHub API responses. Pure function — no
 * network calls — so it can be unit-tested in isolation.
 */
export function buildPRState(
	pr: GHPrJson,
	threads: ReviewThread[],
	checks: CheckRun[],
	existingVerifiedSha: string | null,
): PRState {
	const mergeable = pr.mergeable.toLowerCase();
	const normalizedMergeable = mergeable === "true" || mergeable === "mergeable"
		? "mergeable"
		: mergeable === "false" || mergeable === "conflicting"
			? "conflicting"
			: "unknown";
	const state = pr.state.toLowerCase();
	const normalizedState = state === "closed" || state === "merged" ? state : "open";

	return {
		number: pr.number,
		title: pr.title,
		state: normalizedState,
		isDraft: pr.isDraft,
		headSha: pr.headSha,
		verifiedHeadSha: existingVerifiedSha && existingVerifiedSha === pr.headSha ? existingVerifiedSha : null,
		baseRef: pr.baseRefName,
		headRef: pr.headRefName,
		mergeable: normalizedMergeable,
		checks,
		threads,
		hasUnresolvedThreads:
			threads.filter((t) => t.status === "COMMENTED" || (t.status === "DISMISSED" && t.body.length > 0)).length > 0,
	};
}

/** Check whether the PR is in a merge-ready state (green + no threads + mergeable). */
export function isMergeReady(state: PRState): boolean {
	const allGreen = state.checks.every((c) => c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral");
	return !state.isDraft && allGreen && !state.hasUnresolvedThreads && state.mergeable !== "conflicting";
}

/** Build a human-readable summary of what blocks merge-readiness. */
export function describeBlockers(state: PRState): string {
	const issues: string[] = [];
	if (state.isDraft) issues.push("draft");
	if (state.mergeable === "conflicting") issues.push("conflicts");
	const unresolved = state.threads.filter((t) => t.status === "COMMENTED");
	if (state.hasUnresolvedThreads) issues.push(`unresolved threads (${unresolved.length})`);
	const failing = state.checks.filter((c) => c.conclusion === "failure");
	if (failing.length > 0) issues.push(`${failing.length} failing check(s)`);
	return issues.length > 0 ? issues.join(", ") : "unknown blocker";
}

/** Build the triager task file content from PR state. */
export function buildTriagerTask(state: PRState): string {
	const failures = state.checks.filter((c) => c.conclusion === "failure");
	const pending = state.checks.filter((c) => c.status === "pending");
	const unresolvedThreads = state.threads.filter((t) => t.status === "COMMENTED");

	return `# PR Babysit — Triage

## PR #${state.number}: ${state.title}

- Head SHA: ${state.headSha}
- Base: ${state.baseRef}
- Draft: ${state.isDraft ? "yes" : "no"}
- Mergeable: ${state.mergeable}
- Verified head: ${state.verifiedHeadSha ?? "(not verified)"}

## Checks
${failures.length > 0 ? `Failing (${failures.length}):\n${failures.map((c) => `  - ${c.name}`).join("\n")}` : "  (none failing)"}
${pending.length > 0 ? `Pending (${pending.length}):\n${pending.map((c) => `  - ${c.name}`).join("\n")}` : "  (none pending)"}

## Review threads (${unresolvedThreads.length} open)
${unresolvedThreads.length > 0 ? unresolvedThreads.map((t) => `  - [${t.id}] @${t.commenter}${t.path ? ` ${t.path}:${t.line}` : ""}: ${t.body.slice(0, 200)}`).join("\n") : "  (none)"}

## Classification instructions

For each failing check and each open thread, classify as one of:
- "code" — the failure is in the diff's own code; a fix is possible.
- "stale-base" — the base is behind trunk; needs a rebase (report, do not auto-fix).
- "flake" — infrastructure flakiness; one fresh build is warranted.
- "infra" — external infra issue; retrigger or report.
- "unknown" — cannot determine.

For each thread, also decide whether "fixable" (a code change can address it).

Return ONLY a JSON object:
\`\`\`json
{
  "checks": [{ "name": "...", "cls": "...", "action": "..." }],
  "threads": [{ "id": "...", "cls": "...", "action": "...", "fixable": true }],
  "conflicts": true | false,
  "draft": true | false,
  "summary": "One-line summary of the blocker(s)."
}
\`\`\`
`;
}

/** Build the fixer task file content from PR state + triage. */
export function buildFixerTask(state: PRState, triage: string, fixMode: "threads" | "all"): string {
	return `# PR Babysit — Fix Phase

## PR #${state.number}: ${state.title}
- Head SHA: ${state.headSha}
- Mode: ${fixMode === "threads" ? "address review threads only" : "address threads + code failures"}

## Triage from the tiny-model classifier
\`\`\`
${triage}
\`\`\`

## Current PR state snapshot
${JSON.stringify({
		number: state.number,
		headSha: state.headSha,
		baseRef: state.baseRef,
		headRef: state.headRef,
		mergeable: state.mergeable,
		threads: state.threads.map((t) => ({ id: t.id, commenter: t.commenter, body: t.body, path: t.path, line: t.line })),
		checks: state.checks.map((c) => ({ name: c.name, conclusion: c.conclusion })),
	}, null, 2)}

## Instructions (tiny-model only)

1. Fix each review thread marked "fixable" in the triage. Edit the file at the
   path/line indicated, addressing the comment. Skip threads marked not fixable
   or "stale-base".
2. For check failures classified as "code", fix the root cause in the diff's own
   code. Skip "flake", "infra", and "stale-base" — those are reported, not auto-fixed.
3. Do not stage, commit, or push. The parent babysitter inspects and publishes
   changes only after explicit user confirmation.
4. Do NOT rebase, restack, mark the PR ready, merge, or touch merge settings.
5. Summarize the files changed and the checks you ran.

The working tree is already on the PR's branch. Treat it as the source of truth.
`;
}

/** Pick a tiny model from the config, rotating for independence across cycles. */
export function pickModel(models: ResolvedBabysitConfig["models"], role: BabysitAgentRole, turn: number): { model: string; label: string; thinking?: string } {
	const index = turn % models.length;
	return { model: models[index].model, label: models[index].label, thinking: models[index].thinking };
}

/**
 * Resolve the target PR number: explicit override, or the lowest unmerged
 * open PR in the current repository.
 */
export async function resolveTargetPR(exec: ExecFn, cwd: string, explicitPR: number | undefined): Promise<{ prNumber?: number; error?: string }> {
	if (explicitPR !== undefined) {
		return { prNumber: explicitPR };
	}
	const result = await findLowestUnmergedPR(exec, cwd);
	if (result.prNumber === undefined) {
		return { error: result.stderr || "No open PRs found to babysit." };
	}
	return { prNumber: result.prNumber };
}

/**
 * Fetch the complete PR state snapshot from GitHub.
 */
export async function fetchPRState(exec: ExecFn, cwd: string, prNumber: number, existingVerifiedSha: string | null): Promise<PRState | string> {
	const prResult = await viewPR(exec, cwd, prNumber);
	if (!prResult.pr) return prResult.stderr || `Could not view PR #${prNumber}.`;

	const threadsResult = await getReviewThreads(exec, cwd, prNumber);
	const checksResult = await getCheckRuns(exec, cwd, prNumber);

	return buildPRState(prResult.pr, threadsResult.threads, checksResult.checks, existingVerifiedSha);
}

/**
 * Spawn a tiny-model child to triage the PR state. Returns the raw output
 * (expected to be JSON).
 */
export async function runTriager(
	opts: { model: string; thinking?: string; promptFile: string; taskFile: string },
	ctx: { cwd: string; signal?: AbortSignal },
): Promise<{ ok: true; output: string; usage: UsageSummary } | { ok: false; error: string; usage: UsageSummary }> {
	const result = await runAgent({
		role: "triager",
		spec: { label: "triager", model: opts.model, thinking: opts.thinking },
		promptFile: opts.promptFile,
		taskFile: opts.taskFile,
		cwd: ctx.cwd,
		tools: "read,grep,find,ls",
		signal: ctx.signal,
		deps: {
			timeoutMs: LIMITS.defaultTimeoutMinutes * 60_000,
			maxRuntimeMs: LIMITS.defaultMaxRuntimeMinutes * 60_000,
		},
	});
	if (result.status === "completed") {
		return { ok: true, output: result.output, usage: result.usage };
	}
	return { ok: false, error: result.status === "aborted" ? "Triager was aborted." : `Triager failed: ${result.error}`, usage: result.usage };
}

/** Spawn a tiny-model child to fix review threads and/or CI failures. */
export async function runFixer(
	opts: { model: string; thinking?: string; promptFile: string; taskFile: string },
	ctx: { cwd: string; signal?: AbortSignal },
): Promise<{ ok: true; output: string; usage: UsageSummary } | { ok: false; error: string }> {
	const result = await runAgent({
		role: "fixer",
		spec: { label: "fixer", model: opts.model, thinking: opts.thinking },
		promptFile: opts.promptFile,
		taskFile: opts.taskFile,
		cwd: ctx.cwd,
		tools: "read,grep,find,ls,bash,write,edit",
		signal: ctx.signal,
		deps: {
			timeoutMs: LIMITS.defaultTimeoutMinutes * 60_000,
			maxRuntimeMs: LIMITS.defaultMaxRuntimeMinutes * 60_000,
		},
	});
	if (result.status === "completed") {
		return { ok: true, output: result.output, usage: result.usage };
	}
	return { ok: false, error: result.status === "aborted" ? "Fixer was aborted." : `Fixer failed: ${result.error}` };
}

/** Commit local changes and push to the PR's head branch. */
export async function doCommitAndPush(exec: ExecFn, cwd: string, headRef: string, prNumber: number): Promise<PushResult> {
	const add = await exec("git", ["add", "-A"], { cwd, timeout: 10_000 });
	if (add.code !== 0) return { ok: false, error: `git add failed: ${add.stderr.trim()}` };

	const status = await exec("git", ["status", "--porcelain"], { cwd, timeout: 5_000 });
	const statusOut = status.stdout.trim();
	if (!statusOut) return { ok: true, error: "no changes to commit" };

	const commit = await exec(
		"git",
		["commit", "-m", `Babysit PR #${prNumber}: address review threads and CI failures\n\nCo-authored-by: pr-babysit (tiny models)`],
		{ cwd, timeout: 10_000 },
	);
	if (commit.code !== 0) return { ok: false, error: `git commit failed: ${commit.stderr.trim()}` };

	const push = await exec("git", ["push", "origin", `HEAD:${headRef}`], { cwd, timeout: 30_000 });
	if (push.code !== 0) return { ok: false, error: `git push failed: ${push.stderr.trim()}` };

	const head = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
	return { ok: true, headSha: head.stdout.trim() || undefined };
}

/** Cleanup: remove the managed worktree and suggest session archival. */
export async function runCleanup(
	exec: ExecFn,
	cwd: string,
	confirm: (label: string, body: string) => Promise<boolean>,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<boolean> {
	const branchResult = await exec("git", ["branch", "--show-current"], { cwd, timeout: 5_000 });
	const branch = branchResult.stdout.trim();

	if (!branch.startsWith("kstack/")) {
		notify(`Current branch ${branch || "(detached)"} is not a managed kstack worktree. Cleanup is a no-op for non-managed branches.`, "warning");
		return true;
	}

	const confirmed = await confirm(
		"Remove managed worktree and branch?",
		`Branch: ${branch}\n` +
			`Path: ${cwd}\n\n` +
			"This will:\n" +
			`1. Remove the Git worktree at ${cwd}\n` +
			`2. Delete branch ${branch} (if safe)\n\n` +
			"Session archival is a separate manual step. This cleanup is irreversible. Continue?",
	);
	if (!confirmed) return false;

	const commonDirResult = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: 5_000 });
	const commonDir = commonDirResult.stdout.trim();
	if (commonDirResult.code !== 0 || !commonDir) {
		notify(`Could not locate the owning repository: ${commonDirResult.stderr.trim()}`, "error");
		return false;
	}
	const ownerRoot = join(commonDir, "..");
	const remove = await exec("git", ["worktree", "remove", cwd, "--force"], { cwd: ownerRoot, timeout: 15_000 });
	if (remove.code !== 0) {
		notify(`Worktree removal failed: ${remove.stderr.trim()}. You may need to remove it manually.`, "error");
		return false;
	}

	const deleteResult = await exec("git", ["branch", "-d", branch], { cwd: ownerRoot, timeout: 5_000 });
	if (deleteResult.code !== 0) {
		notify(`Branch deletion warning: ${deleteResult.stderr.trim()}`, "warning");
	}

	notify("Managed worktree and branch removed. To archive the linked Pi session, run: /session-archive", "info");
	return true;
}

// Helpers ------------------------------------------------------------------

/** Parse a triage JSON blob, stripping markdown fence if present. */
export function parseTriage(triage: string): { checks: ParsedCheck[]; threads: ParsedThread[]; conflicts: boolean; draft: boolean; summary: string } | { error: string } {
	let cleaned = triage.trim();
	if (cleaned.startsWith("```json")) cleaned = cleaned.replace(/^```json\n/, "").replace(/\n```$/, "");
	else if (cleaned.startsWith("```")) cleaned = cleaned.replace(/^```\n/, "").replace(/\n```$/, "");
	try {
		return JSON.parse(cleaned) as ParsedTriage;
	} catch (err) {
		return { error: `Could not parse triage JSON: ${(err as Error).message}` };
	}
}

interface ParsedCheck { name: string; cls: string; action: string }
interface ParsedThread { id: string; cls: string; action: string; fixable: boolean }
interface ParsedTriage {
	checks: ParsedCheck[];
	threads: ParsedThread[];
	conflicts: boolean;
	draft: boolean;
	summary: string;
}

/** Summarize the triage output for status display. */
export function summarizeTriage(triage: string): string {
	const parsed = parseTriage(triage);
	if ("error" in parsed) return "triage JSON parse failed";
	return `${parsed.checks.length} checks, ${parsed.threads.length} threads analyzed. ${parsed.summary || ""}`;
}

/** Parse the triage JSON and determine if there are unfixable blockers. */
export function classifyBlockers(triage: string): { hasUnfixableCI: boolean; hasUnfixableThreads: boolean } | { error: string } {
	const parsed = parseTriage(triage);
	if ("error" in parsed) return { error: parsed.error };
	const hasUnfixableCI = parsed.checks.some((c) => c.cls === "infra" || c.cls === "unknown" || c.cls === "stale-base");
	const hasUnfixableThreads = parsed.threads.some((t) => !t.fixable);
	return { hasUnfixableCI, hasUnfixableThreads };
}

// -- Main entry point -------------------------------------------------------

/**
 * The main babysit loop. Drives the state machine through check → triage →
 * fix → push → recheck, respecting the mode boundaries.
 */
export async function runBabysit(
	mode: BabysitMode,
	params: {
		config: ResolvedBabysitConfig;
		exec: ExecFn;
		cwd: string;
		explicitPR?: number;
		promptDir: string;
		triagerPromptFile: string;
		fixerPromptFile: string;
	},
	handlers: {
		setPhase: (phase: LifecyclePhase) => void;
		notify: (msg: string, level: "info" | "warning" | "error") => void;
		confirm: (label: string, body: string) => Promise<boolean>;
	},
	signal: AbortSignal,
): Promise<BabysitResult> {
	const { config, exec, cwd, promptDir, triagerPromptFile, fixerPromptFile } = params;
	const { setPhase, notify, confirm } = handlers;
	let usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const blockedReasons: string[] = [];

	const accumulateUsage = (u: Partial<UsageSummary>) => {
		usage = {
			input: usage.input + (u.input ?? 0),
			output: usage.output + (u.output ?? 0),
			cacheRead: usage.cacheRead + (u.cacheRead ?? 0),
			cacheWrite: usage.cacheWrite + (u.cacheWrite ?? 0),
			cost: usage.cost + (u.cost ?? 0),
			turns: usage.turns + (u.turns ?? 0),
		};
	};

	// Resolve the target PR.
	setPhase("discovering");
	const target = await resolveTargetPR(exec, cwd, params.explicitPR);
	if (target.error || !target.prNumber) {
		const msg = target.error ?? "No PR to babysit.";
		notify(msg, "error");
		return { status: "blocked", mergeReady: false, cyclesCompleted: 0, blockedReasons: [msg], usage };
	}
	const prNumber = target.prNumber;
	notify(`Babysitting PR #${prNumber} in ${mode} mode. Models: ${config.models.map((m) => m.label).join(", ")}`, "info");

	// Check mode: one status pass, report, stop.
	if (mode === "check") {
		setPhase("checking");
		const state = await fetchPRState(exec, cwd, prNumber, null);
		setPhase("idle");
		if (typeof state === "string") {
			notify(state, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: 0, blockedReasons: [state], usage };
		}
		const ready = isMergeReady(state);
		if (ready) {
			notify(`PR #${prNumber} is merge-ready.`, "info");
		} else {
			notify(`PR #${prNumber} is not ready: ${describeBlockers(state)}`, "warning");
		}
		return { status: ready ? "merge-ready" : "incomplete", prState: state, mergeReady: ready, cyclesCompleted: 0, blockedReasons: ready ? [] : [describeBlockers(state)], usage };
	}

	// Cleanup mode: remove managed worktree + suggest session archive.
	if (mode === "cleanup") {
		setPhase("cleaning");
		const ok = await runCleanup(exec, cwd, confirm, notify);
		setPhase("idle");
		return { status: ok ? "cleaned" : "blocked", mergeReady: false, cyclesCompleted: 0, blockedReasons: ok ? [] : ["cleanup not confirmed"], usage };
	}

	// Threads and drive modes: run the check → triage → fix → push → recheck loop.
	let state: PRState | null = null;
	let verifiedHeadSha: string | null = null;
	let cycle = 0;
	const maxCycles = mode === "threads" ? 1 : 3;

	while (cycle < maxCycles) {
		cycle++;
		if (signal.aborted) {
			return { status: "aborted", mergeReady: false, cyclesCompleted: cycle - 1, blockedReasons: ["aborted by user"], usage };
		}

		// --- CHECK ---
		setPhase("checking");
		const fetched = await fetchPRState(exec, cwd, prNumber, verifiedHeadSha);
		if (typeof fetched === "string") {
			notify(fetched, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: cycle - 1, blockedReasons: [fetched], usage };
		}
		state = fetched;
		notify(
			`Cycle ${cycle}: PR #${prNumber} — mergeable=${state.mergeable}, draft=${state.isDraft}, threads=${state.threads.length}, checks=${state.checks.length}`,
			"info",
		);

		// If already merge-ready, stop (don't push, don't merge).
		if (isMergeReady(state)) {
			verifiedHeadSha = state.headSha;
			setPhase("idle");
			notify(`PR #${prNumber} is merge-ready. Stop at merge-ready — not merging.`, "info");
			return { status: "merge-ready", prState: state, mergeReady: true, cyclesCompleted: cycle, blockedReasons: [], usage };
		}

		// --- Hard blockers that require a human ---
		if (state.mergeable === "conflicting") {
			notify(`PR #${prNumber} has merge conflicts against ${state.baseRef}. Report to the owner — do not rebase from the babysitter.`, "error");
			blockedReasons.push("merge conflicts (human must rebase)");
			break;
		}

		if (state.isDraft) {
			notify(`PR #${prNumber} is still a draft. Mark it ready for review, then rerun.`, "error");
			blockedReasons.push("PR is a draft");
			break;
		}

		// --- TRIAGE ---
		setPhase("triaging");
		const model = pickModel(config.models, "triager", cycle - 1);
		const triagerTask = buildTriagerTask(state);
		const taskFile = join(promptDir, `triager-${cycle}.md`);
		await writeFile(taskFile, triagerTask, { mode: 0o600 });

		const triagerResult = await runTriager(
			{ model: model.model, thinking: model.thinking, promptFile: triagerPromptFile, taskFile },
			{ cwd, signal },
		);
		if (!triagerResult.ok) {
			notify(`Triager failed: ${triagerResult.error}`, "error");
			accumulateUsage(triagerResult.usage);
			blockedReasons.push("triager failed");
			break;
		}

		const triage = triagerResult.output;
		accumulateUsage(triagerResult.usage);
		notify(`Triager (${model.label}) classified: ${summarizeTriage(triage)}`, "info");

		// --- Classify blockers ---
		const classification = classifyBlockers(triage);
		if ("error" in classification) {
			notify(`Triage parse failed: ${classification.error}`, "warning");
		} else {
			if (classification.hasUnfixableCI) blockedReasons.push("unfixable CI failures remain");
			if (classification.hasUnfixableThreads) blockedReasons.push("unaddressed review threads remain");
		}

		// --- FIX ---
		const fixMode = mode === "threads" ? "threads" : "all";
		const fixerModel = pickModel(config.models, "fixer", cycle);
		setPhase("fixing");
		const fixerTask = buildFixerTask(state, triage, fixMode);
		const fixerTaskFile = join(promptDir, `fixer-${cycle}.md`);
		await writeFile(fixerTaskFile, fixerTask, { mode: 0o600 });

		const fixerResult = await runFixer(
			{ model: fixerModel.model, thinking: fixerModel.thinking, promptFile: fixerPromptFile, taskFile: fixerTaskFile },
			{ cwd, signal },
		);
		if (!fixerResult.ok) {
			notify(`Fixer failed: ${fixerResult.error}`, "error");
			blockedReasons.push("fixer failed");
			break;
		}
		accumulateUsage(fixerResult.usage);

		// --- COMMIT & PUSH ---
		setPhase("pushing");
		const confirmed = await confirm(
			`Push fixes to PR #${prNumber}?`,
			`Cycle ${cycle} fixer (${fixerModel.label}) completed.\n` +
				"Committing verified local changes and pushing to the PR head branch.\n" +
				"The babysitter will NOT rebase, restack, merge, or touch merge settings.",
		);
		if (!confirmed) {
			notify("Push not confirmed. Stopping.", "info");
			return { status: "incomplete", mergeReady: false, cyclesCompleted: cycle, blockedReasons: ["push not confirmed"], usage };
		}

		const pushResult = await doCommitAndPush(exec, cwd, state.headRef, prNumber);
		if (pushResult.ok && pushResult.error === "no changes to commit") {
			notify("Fixer found nothing to commit. Skipping push.", "warning");
		} else if (!pushResult.ok) {
			notify(`Push failed: ${pushResult.error}`, "error");
			blockedReasons.push(`push failed: ${pushResult.error}`);
			break;
		} else {
			notify(`Pushed to ${state.headRef} (new HEAD: ${pushResult.headSha?.slice(0, 8) ?? "?"}).`, "info");
		}

		// Invalidate pinned verification — we pushed, so a re-check is required.
		verifiedHeadSha = null;

		// Threads mode: one cycle is enough.
		if (mode === "threads") {
			setPhase("rechecking");
			const recheck = await fetchPRState(exec, cwd, prNumber, null);
			setPhase("idle");
			if (typeof recheck !== "string") {
				state = recheck;
				const ready = isMergeReady(state);
				if (ready) {
					verifiedHeadSha = state.headSha;
					notify(`PR #${prNumber} is now merge-ready after addressing threads.`, "info");
					return { status: "merge-ready", prState: state, mergeReady: true, cyclesCompleted: cycle, blockedReasons: [], usage };
				}
				notify(`PR #${prNumber} still not ready after threads. Run drive mode to continue.`, "warning");
				return { status: "incomplete", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [describeBlockers(state)], usage };
			}
			return { status: "incomplete", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [recheck], usage };
		}

		// Drive mode: continue looping.
	}

	// Exhausted cycles without merge-ready.
	setPhase("idle");
	if (blockedReasons.length === 0) blockedReasons.push("max cycles reached without merge-ready");
	return {
		status: "blocked",
		mergeReady: state ? isMergeReady(state) : false,
		cyclesCompleted: cycle,
		blockedReasons,
		usage,
	};
}
