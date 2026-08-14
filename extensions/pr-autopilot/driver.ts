/**
 * Bounded PR autopilot state machine.
 *
 * One PR at a time, lowest unmerged first. Tiny models only. The loop:
 *
 *   refresh snapshot → conflicts/behind (merge base, never rebase)
 *   → unresolved threads (fix / dismiss / ask)
 *   → watch pending CI instead of inventing work
 *   → flake retrigger once
 *   → code CI (after comments, on the current SHA)
 *   → verify, push, recheck
 *
 * Modes:
 *   check    — one status pass, report, stop.
 *   threads  — address review threads only, then push.
 *   drive    — loop until merge-ready or a hard blocker (3 fix cycles).
 *   watch    — same as drive with more cycles, watching CI between ticks.
 *   cleanup  — remove the managed worktree and branch after confirmation.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	attachFailedLogs,
	currentBranch,
	currentHead,
	findLowestUnmergedPR,
	getCheckRuns,
	getIssueComments,
	getReviewThreads,
	integrateRemoteHead,
	isForbiddenStagingPath,
	markPrReady,
	mergeBaseIntoHead,
	parsePorcelainPaths,
	replyToIssueComment,
	replyToReviewComment,
	resolveReviewThread,
	rerunFailedRun,
	viewPR,
	watchChecks,
	type GHPrJson,
} from "./github.ts";
import { runAgent } from "./agent-runner.ts";
import { LIMITS, type AutopilotAgentRole, type AutopilotModelSpec, type AutopilotMode, type AutopilotPersistedState, type CheckRun, type ExecFn, type FailureClass, type PRState, type ResolvedAutopilotConfig, type ReviewThread, type ThreadDecision, type UsageSummary } from "./types.ts";
import { shouldForceAsk, untrustedFenceNote, wrapUntrusted } from "./untrusted.ts";

/** Lifecycle phases surfaced to the parent UI for status display. */
import { emptyUsage, isCodeReady, isMergeReady, describeBlockers, buildTriagerTask, buildFixerTask, pickModel, resolveTargetPR, hasPendingChecks, hasFailingChecks, type FixMode } from "./pr-state.ts";
import { repoPersistKey, loadPersistedState, fetchPRState, runCleanup, prepareMutationCheckout, savePersistedState, runChildRole, parseTriage, applyForceAsk, summarizeTriage, doCommitAndPush, applyThreadReplies, maxFixCycles } from "./autopilot-operations.ts";
export type LifecyclePhase =
	| "idle"
	| "discovering"
	| "checking"
	| "watching"
	| "merging-base"
	| "triaging"
	| "fixing"
	| "replying"
	| "pushing"
	| "rechecking"
	| "settling"
	| "cleaning";

/** Outcome of a full autopilot run. */
export interface AutopilotResult {
	status: "merge-ready" | "blocked" | "incomplete" | "cleaned" | "aborted" | "failed";
	prState?: PRState;
	mergeReady: boolean;
	cyclesCompleted: number;
	blockedReasons: string[];
	usage: UsageSummary;
}

export async function runAutopilot(
	mode: AutopilotMode,
	params: {
		config: ResolvedAutopilotConfig;
		exec: ExecFn;
		cwd: string;
		explicitPR?: number;
		promptDir: string;
		triagerPromptFile: string;
		fixerPromptFile: string;
	},
	handlers: {
		setPhase: (phase: LifecyclePhase, cycles?: number) => void;
		notify: (msg: string, level: "info" | "warning" | "error") => void;
		confirm: (label: string, body: string) => Promise<boolean>;
	},
	signal: AbortSignal,
): Promise<AutopilotResult> {
	const { config, exec, cwd, promptDir, triagerPromptFile, fixerPromptFile } = params;
	const { setPhase, notify, confirm } = handlers;
	let usage = emptyUsage();
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

	setPhase("discovering");
	const target = await resolveTargetPR(exec, cwd, params.explicitPR);
	if (target.error || !target.prNumber) {
		const msg = target.error ?? "No PR to drive.";
		notify(msg, "error");
		return { status: "blocked", mergeReady: false, cyclesCompleted: 0, blockedReasons: [msg], usage };
	}
	const prNumber = target.prNumber;
	const repoKey = repoPersistKey(cwd);
	notify(`Driving PR #${prNumber} in ${mode} mode. Models: ${config.models.map((m) => m.label).join(", ")}`, "info");

	if (mode === "check") {
		setPhase("checking");
		const persisted = await loadPersistedState(repoKey, prNumber);
		const state = await fetchPRState(exec, cwd, prNumber, null, { concurrency: config.maxConcurrency, handledThreadIds: persisted.handledThreadIds });
		setPhase("idle");
		if (typeof state === "string") {
			notify(state, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: 0, blockedReasons: [state], usage };
		}
		const verified = await fetchPRState(exec, cwd, prNumber, state.headSha, { concurrency: config.maxConcurrency, handledThreadIds: persisted.handledThreadIds });
		if (typeof verified === "string") {
			return { status: "failed", mergeReady: false, cyclesCompleted: 0, blockedReasons: [verified], usage };
		}
		setPhase("idle");
		const ready = isMergeReady(verified);
		if (ready) {
			notify(`PR #${prNumber} looks merge-ready after a fresh status read.`, "info");
		} else {
			notify(`PR #${prNumber} is not ready: ${describeBlockers(verified)}.`, "warning");
		}
		return { status: ready ? "merge-ready" : "incomplete", prState: verified, mergeReady: ready, cyclesCompleted: 0, blockedReasons: ready ? [] : [describeBlockers(verified)], usage };
	}

	if (mode === "cleanup") {
		setPhase("cleaning");
		const ok = await runCleanup(exec, cwd, confirm, notify);
		setPhase("idle");
		return { status: ok ? "cleaned" : "blocked", mergeReady: false, cyclesCompleted: 0, blockedReasons: ok ? [] : ["cleanup not confirmed"], usage };
	}

	let state: PRState | null = null;
	let verifiedHeadSha: string | null = null;
	let cycle = 0;
	const maxCycles = maxFixCycles(mode);
	let persisted = await loadPersistedState(repoKey, prNumber);

	const refresh = async (): Promise<PRState | string> => {
		setPhase("checking", cycle);
		return fetchPRState(exec, cwd, prNumber, verifiedHeadSha, {
			concurrency: config.maxConcurrency,
			handledThreadIds: persisted.handledThreadIds,
		});
	};

	const declareReady = async (snapshot: PRState): Promise<AutopilotResult | undefined> => {
		if (!isCodeReady(snapshot)) return undefined;
		if (snapshot.isDraft || snapshot.mergeStateStatus === "DRAFT") {
			const mark = await confirm(
				`PR #${prNumber} is code-ready but still a draft. Mark it ready for review?`,
				"The autopilot will not merge. Marking ready is a PR state change and needs your say.",
			);
			if (!mark) {
				blockedReasons.push("code-ready but still a draft (mark-ready not confirmed)");
				return { status: "incomplete", prState: snapshot, mergeReady: false, cyclesCompleted: cycle, blockedReasons: [...blockedReasons], usage };
			}
			const readyResult = await markPrReady(exec, cwd, prNumber);
			if (readyResult.code !== 0) {
				blockedReasons.push(`could not mark ready: ${readyResult.stderr.trim()}`);
				return { status: "blocked", prState: snapshot, mergeReady: false, cyclesCompleted: cycle, blockedReasons: [...blockedReasons], usage };
			}
		}
		setPhase("settling", cycle);
		const settled = await fetchPRState(exec, cwd, prNumber, snapshot.headSha, {
			concurrency: config.maxConcurrency,
			handledThreadIds: persisted.handledThreadIds,
		});
		if (typeof settled === "string") {
			notify(settled, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [settled], usage };
		}
		if (settled.headSha !== snapshot.headSha) {
			notify(`PR #${prNumber} advanced from ${snapshot.headSha.slice(0, 8)} to ${settled.headSha.slice(0, 8)} during verification; rechecking.`, "warning");
			state = settled;
			return undefined;
		}
		if (!isMergeReady(settled)) {
			notify(`PR #${prNumber} looked ready, then the settle re-read showed: ${describeBlockers(settled)}.`, "warning");
			state = settled;
			return undefined;
		}
		verifiedHeadSha = settled.headSha;
		setPhase("idle", cycle);
		notify(`PR #${prNumber} looks merge-ready after a fresh status read. Not merging.`, "info");
		return { status: "merge-ready", prState: settled, mergeReady: true, cyclesCompleted: cycle, blockedReasons: [], usage };
	};

	while (cycle < maxCycles) {
		if (signal.aborted) {
			return { status: "aborted", mergeReady: false, cyclesCompleted: cycle, blockedReasons: ["aborted by user"], usage };
		}

		const fetched = await refresh();
		if (typeof fetched === "string") {
			notify(fetched, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [fetched], usage };
		}
		state = fetched;
		notify(
			`PR #${prNumber} — ${describeBlockers(state) === "unknown blocker" && isCodeReady(state) ? "code-ready" : describeBlockers(state)} (sha ${state.headSha.slice(0, 8)})`,
			"info",
		);

		const ready = await declareReady(state);
		if (ready) return ready;

		const checkout = await prepareMutationCheckout(exec, cwd, state);
		if (!checkout.ok) {
			notify(checkout.error, "error");
			return { status: "blocked", prState: state, mergeReady: false, cyclesCompleted: cycle, blockedReasons: [checkout.error], usage };
		}

		if (state.mergeable === "conflicting" || state.mergeStateStatus === "DIRTY" || state.mergeStateStatus === "BEHIND") {
			setPhase("merging-base", cycle);
			notify(`PR #${prNumber} is ${state.mergeStateStatus === "BEHIND" ? "behind" : "conflicted"} against ${state.baseRef}. Merging origin/${state.baseRef} (no rebase).`, "info");
			const merged = await mergeBaseIntoHead(exec, cwd, state.baseRef);
			switch (merged.kind) {
				case "already-current":
					notify(`origin/${state.baseRef} is already in HEAD; refreshing GitHub state.`, "info");
					cycle++;
					continue;
				case "clean": {
					const push = await exec("git", ["push", "origin", `HEAD:${state.headRef}`], { cwd, timeout: 30_000 });
					if (push.code !== 0) {
						blockedReasons.push(`Could not push merged base: ${push.stderr.trim()}`);
						break;
					}
					notify(`Merged origin/${state.baseRef} and pushed ${merged.headSha.slice(0, 8)}.`, "info");
					verifiedHeadSha = null;
					persisted = { ...persisted, headSha: merged.headSha };
					await savePersistedState(persisted);
					cycle++;
					continue;
				}
				case "needs-human":
					notify(merged.error, "error");
					blockedReasons.push(merged.error);
					break;
				case "failed":
					notify(merged.error, "error");
					blockedReasons.push(merged.error);
					break;
				default: {
					const _exhaustive: never = merged;
					return _exhaustive;
				}
			}
			break;
		}

		if (hasPendingChecks(state) && !hasFailingChecks(state) && !state.hasUnresolvedThreads) {
			setPhase("watching", cycle);
			notify(`PR #${prNumber}: nothing actionable and checks are still running. Watching CI instead of inventing work.`, "info");
			const watched = await watchChecks(exec, cwd, prNumber, LIMITS.watchTimeoutMinutes * 60_000, signal);
			if (signal.aborted) {
				return { status: "aborted", mergeReady: false, cyclesCompleted: cycle, blockedReasons: ["aborted by user"], usage };
			}
			if (watched.code !== 0) {
				notify(`CI watch ended: ${watched.stderr.trim() || "a check failed or the watch timed out"}.`, "warning");
			}
			const afterWatch = await refresh();
			if (typeof afterWatch === "string") {
				notify(afterWatch, "error");
				return { status: "failed", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [afterWatch], usage };
			}
			state = afterWatch;
			if (hasPendingChecks(state) && !hasFailingChecks(state) && !state.hasUnresolvedThreads) {
				blockedReasons.push("CI still pending after watch");
				break;
			}
			continue;
		}

		setPhase("triaging", cycle);
		const model = pickModel(config.models, cycle);
		const taskFile = join(promptDir, `triager-${cycle + 1}.md`);
		await writeFile(taskFile, buildTriagerTask(state), { mode: 0o600 });
		const triagerResult = await runChildRole("triager",
			{
				model: model.model,
				thinking: model.thinking,
				promptFile: triagerPromptFile,
				taskFile,
				timeoutMinutes: config.timeoutMinutes,
				maxRuntimeMinutes: config.maxRuntimeMinutes,
			},
			{ cwd, signal },
		);
		if (!triagerResult.ok) {
			notify(`Triager failed: ${triagerResult.error}`, "error");
			accumulateUsage(triagerResult.usage);
			blockedReasons.push("triager failed");
			break;
		}
		accumulateUsage(triagerResult.usage);
		const parsedRaw = parseTriage(triagerResult.output);
		if ("error" in parsedRaw) {
			notify(`Triage parse failed: ${parsedRaw.error}`, "error");
			blockedReasons.push(parsedRaw.error);
			break;
		}
		const parsed = applyForceAsk(state, parsedRaw);
		notify(`Cause: ${parsed.summary || summarizeTriage(triagerResult.output)}`, "info");

		const askThreads = parsed.threads.filter((t) => t.decision === "ask");
		if (askThreads.length > 0) {
			const lines = askThreads.map((t) => {
				const source = state?.threads.find((s) => s.id === t.id);
				return `- ${t.id}${source?.path ? ` ${source.path}` : ""}: ${t.action}`;
			});
			notify(`Ask (not guessing): ${lines.join("; ")}`, "error");
			blockedReasons.push(`ask threads: ${askThreads.map((t) => t.id).join(", ")}`);
		}

		const flakeKey = (name: string) => `${name}@${state?.headSha ?? ""}`;
		const flakeChecks = parsed.checks.filter((c) => c.cls === "flake");
		const newFlakes = flakeChecks.filter((c) => state && !persisted.flakeRetried.includes(flakeKey(c.name)));
		if (newFlakes.length > 0 && state) {
			let reran = false;
			for (const flake of newFlakes) {
				const check = state.checks.find((c) => c.name === flake.name);
				if (!check?.runId) continue;
				const rerun = await rerunFailedRun(exec, cwd, check.runId);
				persisted = { ...persisted, flakeRetried: [...persisted.flakeRetried, flakeKey(flake.name)] };
				if (rerun.code === 0) {
					notify(`Cause: flake on ${flake.name}. Reran failed jobs once on SHA ${state.headSha.slice(0, 8)}.`, "info");
					reran = true;
				} else {
					notify(`Could not rerun ${flake.name}: ${rerun.stderr.trim()}`, "warning");
				}
			}
			await savePersistedState(persisted);
			if (reran) {
				cycle++;
				continue;
			}
		}

		const staleOrInfra = parsed.checks.filter((c) => c.cls === "stale-base" || c.cls === "infra" || c.cls === "unknown");
		const codeChecks = parsed.checks.filter((c) => c.cls === "code");
		const fixThreads = parsed.threads.filter((t) => t.decision === "fix");
		const dismissThreads = parsed.threads.filter((t) => t.decision === "dismiss");

		const commentsFirst = mode === "threads" || fixThreads.length > 0 || dismissThreads.length > 0;
		const fixMode: FixMode = mode === "threads" ? "threads" : commentsFirst && codeChecks.length > 0 ? "threads" : codeChecks.length > 0 ? "ci" : "threads";

		if (fixThreads.length === 0 && dismissThreads.length === 0 && codeChecks.length === 0) {
			if (askThreads.length > 0) break;
			if (staleOrInfra.length > 0) {
				blockedReasons.push(staleOrInfra.map((c) => `${c.name}: ${c.cls} (${c.action})`).join("; "));
				break;
			}
			blockedReasons.push("triage found nothing the autopilot can fix");
			break;
		}

		let fixerOutput = "";
		let pushedAFix = false;
		if (fixThreads.length > 0 || (fixMode === "ci" && codeChecks.length > 0)) {
			const fixerModel = pickModel(config.models, cycle + 1);
			setPhase("fixing", cycle);
			const fixerTaskFile = join(promptDir, `fixer-${cycle + 1}.md`);
			await writeFile(fixerTaskFile, buildFixerTask(state, JSON.stringify(parsed), fixMode), { mode: 0o600 });
			const fixerResult = await runChildRole("fixer",
				{
					model: fixerModel.model,
					thinking: fixerModel.thinking,
					promptFile: fixerPromptFile,
					taskFile: fixerTaskFile,
					timeoutMinutes: config.timeoutMinutes,
					maxRuntimeMinutes: config.maxRuntimeMinutes,
				},
				{ cwd, signal },
			);
			if (!fixerResult.ok) {
				notify(`Fixer failed: ${fixerResult.error}`, "error");
				accumulateUsage(fixerResult.usage);
				blockedReasons.push("fixer failed");
				break;
			}
			accumulateUsage(fixerResult.usage);
			fixerOutput = fixerResult.output;

			setPhase("pushing", cycle);
			const confirmed = await confirm(
				`Push fixes to PR #${prNumber}?`,
				`Cycle ${cycle + 1} fixer (${fixerModel.label}) completed.\n` +
					"Integrating origin/" + state.headRef + ", staging only touched paths, then pushing.\n" +
					"The autopilot will NOT rebase, restack, merge the PR, or touch merge settings.",
			);
			if (!confirmed) {
				notify("Push not confirmed. Stopping.", "info");
				return { status: "incomplete", mergeReady: false, cyclesCompleted: cycle, blockedReasons: ["push not confirmed"], usage };
			}
			const pushResult = await doCommitAndPush(exec, cwd, state.headRef, state.headSha, prNumber, fixerOutput);
			if (pushResult.ok && pushResult.error === "no changes to commit") {
				notify("Fixer found nothing to commit. Skipping push.", "warning");
			} else if (!pushResult.ok) {
				notify(`Push failed: ${pushResult.error}`, "error");
				blockedReasons.push(`push failed: ${pushResult.error}`);
				break;
			} else {
				notify(`Pushed to ${state.headRef} (new HEAD: ${pushResult.headSha?.slice(0, 8) ?? "?"}). Prior CI on the old SHA is stale.`, "info");
				verifiedHeadSha = null;
				persisted = { ...persisted, headSha: pushResult.headSha ?? "" };
				pushedAFix = true;
			}
		}

		setPhase("replying", cycle);
		const repliedThreadIds = [...persisted.repliedThreadIds];
		const handled = await applyThreadReplies(exec, cwd, state, parsed, { resolveFix: pushedAFix, repliedThreadIds }, notify);
		if (handled.length > 0) {
			persisted = { ...persisted, handledThreadIds: [...persisted.handledThreadIds, ...handled], repliedThreadIds: repliedThreadIds.filter((id) => !handled.includes(id)) };
			notify(`Replied and resolved ${handled.length} thread(s).`, "info");
		} else {
			persisted = { ...persisted, repliedThreadIds };
		}
		await savePersistedState(persisted);

		if (mode === "threads") {
			const recheck = await refresh();
			setPhase("idle", cycle + 1);
			if (typeof recheck === "string") {
				return { status: "incomplete", mergeReady: false, cyclesCompleted: cycle + 1, blockedReasons: [recheck], usage };
			}
			const done = await declareReady(recheck);
			if (done) return done;
			notify(`PR #${prNumber} still not ready after threads: ${describeBlockers(recheck)}.`, "warning");
			return { status: "incomplete", prState: recheck, mergeReady: false, cyclesCompleted: cycle + 1, blockedReasons: [describeBlockers(recheck)], usage };
		}

		if (askThreads.length > 0 && fixThreads.length === 0 && codeChecks.length === 0) {
			break;
		}

		cycle++;
	}

	setPhase("idle", cycle);
	if (blockedReasons.length === 0) blockedReasons.push("max cycles reached without merge-ready");
	return {
		status: "blocked",
		mergeReady: state ? isMergeReady(state) : false,
		cyclesCompleted: cycle,
		blockedReasons,
		usage,
	};
}
