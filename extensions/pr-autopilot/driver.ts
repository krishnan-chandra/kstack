import { isString } from "../shared/validation.ts";
/**
 * Bounded PR autopilot state machine.
 *
 * One PR at a time, lowest unmerged first. Configured models only. The loop:
 *
 *   refresh snapshot → conflicts/behind (merge base, never rebase)
 *   → unresolved review items (fix / dismiss / ask / ignore)
 *   → watch pending CI instead of inventing work
 *   → flake retrigger once
 *   → code CI (after comments, on the current SHA)
 *   → verify, push, recheck
 *
 * The local workspace is validated lazily, immediately before a mutation
 * (base merge or fixer edit). Readiness-only passes — merge-ready checks,
 * CI watching, triage, and thread replies — never require the PR's
 * worktree or jj checkpoint, so a stack lander can drive PRs whose
 * bookmarks are not checked out.
 *
 * Modes:
 *   check    — two fresh status reads, report, stop.
 *   threads  — address review threads only, then push.
 *   drive    — loop until merge-ready or a hard blocker (3 fix cycles).
 *   watch    — same as drive with more cycles, watching CI between ticks.
 *   cleanup  — remove the managed worktree and branch after confirmation.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { VcsBackend } from "../shared/vcs/backend.ts";
import { createPrMutation } from "../shared/vcs/mutation.ts";
import { vcsPolicy } from "../shared/vcs/policy.ts";
import {
	applyThreadReplies,
	applyTriageGuardrails,
	fetchPRState,
	loadPersistedState,
	maxFixCycles,
	parseTriage,
	repoPersistKey,
	runChildRole,
	runCleanup,
	savePersistedState,
	summarizeTriage,
} from "./autopilot-operations.ts";
import { attachFailedLogs, isForbiddenStagingPath, markPrReady, rerunFailedRun, watchChecks } from "./github.ts";
/** Lifecycle phases surfaced to the parent UI for status display. */
import {
	buildFixerTask,
	buildTriagerTask,
	describeBlockers,
	emptyUsage,
	type FixMode,
	hasFailingChecks,
	hasPendingChecks,
	isCodeReady,
	isMergeabilityPending,
	isMergeReady,
	isMergeReadyIgnoringHeadVerification,
	pickModel,
	resolveTargetPR,
} from "./pr-state.ts";
import { appendHandledReviewRecords, reconcileLegacyPendingReplyIds } from "./review-handling.ts";
import { checkForTriageKey, threadForTriageKey } from "./triage-keys.ts";
import {
	type AutopilotMode,
	type AutopilotModelSpec,
	type AutopilotResult,
	type ExecFn,
	LIMITS,
	type PRState,
	type ResolvedAutopilotConfig,
	type UsageSummary,
} from "./types.ts";
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

export interface DriverOps {
	runChildRole: typeof runChildRole;
	loadPersistedState: typeof loadPersistedState;
	savePersistedState: typeof savePersistedState;
	sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

const MERGEABILITY_POLL_LIMIT = 5;
const MERGEABILITY_POLL_DELAY_MS = 1000;
const defaultOps: DriverOps = {
	runChildRole,
	loadPersistedState,
	savePersistedState,
	sleep: (delayMs, signal) => sleep(delayMs, undefined, { signal }),
};

export async function runAutopilot(
	mode: AutopilotMode,
	params: {
		config: ResolvedAutopilotConfig;
		exec: ExecFn;
		backend: VcsBackend;
		cwd: string;
		/** Validated owner/name; omitted only for repository-independent cleanup. */
		repository?: string;
		explicitPR?: number;
		promptDir: string;
		triagerPromptFile: string;
		fixerPromptFile: string;
		/** One configured model for every child in this run. Chosen before confirmation. */
		selectedModel?: Pick<AutopilotModelSpec, "model" | "label" | "thinking">;
	},
	handlers: {
		setPhase: (phase: LifecyclePhase, cycles?: number) => void;
		notify: (msg: string, level: "info" | "warning" | "error") => void;
		confirm: (label: string, body: string) => Promise<boolean>;
	},
	signal: AbortSignal,
	ops: DriverOps = defaultOps,
): Promise<AutopilotResult> {
	const { config, exec, backend, cwd, promptDir, triagerPromptFile, fixerPromptFile } = params;
	const { setPhase, notify, confirm } = handlers;
	const policy = vcsPolicy(backend.id);
	const mutation = createPrMutation(backend, { signal });
	let state: PRState | null = null;
	let cycle = 0;
	let usage = emptyUsage();
	const blockedReasons: string[] = [];
	const blockedCodes: NonNullable<AutopilotResult["blockedCodes"]> = [];

	// Every mode finishes here, after any in-flight operation has settled.
	const finish = (
		status: AutopilotResult["status"],
		reasons: string[] = blockedReasons,
		completedActions: string[] = [],
	): AutopilotResult => {
		const cancelled = signal.aborted || status === "aborted";
		const unpublished = completedActions.map((action) => `${action}; changes remain unpublished by this run`);
		for (const message of unpublished) notify(message, "warning");
		setPhase("idle", cycle);
		return {
			status: cancelled ? "aborted" : status,
			prState: state ?? undefined,
			mergeReady:
				!cancelled && (status === "merge-ready" || (status === "blocked" && state !== null && isMergeReady(state))),
			cyclesCompleted: cycle,
			blockedReasons: [...new Set([...(cancelled ? ["aborted by user"] : []), ...reasons, ...unpublished])],
			blockedCodes,
			usage,
		};
	};

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

	if (signal.aborted) return finish("aborted");
	setPhase("discovering");
	if (mode !== "check") {
		const preflight = await backend.preflight(cwd);
		if (signal.aborted) return finish("aborted");
		if (!preflight.ok) {
			notify(preflight.error, "error");
			return finish("blocked", [preflight.error]);
		}
	}
	if (mode !== "cleanup" && params.repository === undefined) {
		const reason = "PR autopilot requires a resolved GitHub repository.";
		notify(reason, "error");
		return finish("blocked", [reason]);
	}
	const target = await resolveTargetPR(exec, cwd, params.explicitPR);
	if (signal.aborted) return finish("aborted");
	if (target.error || !target.prNumber) {
		const msg = target.error ?? "No PR to drive.";
		notify(msg, "error");
		return finish("blocked", [msg]);
	}
	const prNumber = target.prNumber;
	const repoKey = repoPersistKey(cwd);
	const repoName = params.repository;
	const selected = params.selectedModel ?? pickModel(config.models);
	const terminalPrReason = (snapshot: PRState): string | undefined =>
		snapshot.state === "open" ? undefined : describeBlockers(snapshot);
	notify(`Driving PR #${prNumber} in ${mode} mode. Model: ${selected.label}`, "info");

	if (mode === "check") {
		setPhase("checking");
		const loaded = await ops.loadPersistedState(repoKey, prNumber);
		let persisted = loaded.state;
		const migrationNote = loaded.kind === "ready" ? loaded.migrationNote : undefined;
		const reviewMutationBlocker = loaded.kind === "blocked" ? loaded.reviewMutationBlocker : undefined;
		if (migrationNote) {
			notify(migrationNote, "warning");
			await ops.savePersistedState(persisted);
		}
		if (reviewMutationBlocker) notify(reviewMutationBlocker, "warning");
		if (signal.aborted) return finish("aborted");
		const fetched = await fetchPRState(exec, cwd, prNumber, null, persisted, repoName, signal);
		if (signal.aborted) return finish("aborted");
		if (isString(fetched)) {
			notify(fetched, "error");
			return finish("failed", [fetched]);
		}
		state = fetched;
		const firstTerminalReason = terminalPrReason(fetched);
		const reconciled = reconcileLegacyPendingReplyIds(persisted.legacyPendingReplyIds, fetched.threads);
		if (!reviewMutationBlocker && reconciled.length !== persisted.legacyPendingReplyIds.length) {
			persisted = { ...persisted, legacyPendingReplyIds: reconciled };
			await ops.savePersistedState(persisted);
		}
		if (signal.aborted) return finish("aborted");
		const verified = await fetchPRState(exec, cwd, prNumber, state.headSha, persisted, repoName, signal);
		if (signal.aborted) return finish("aborted");
		if (isString(verified)) {
			return finish("failed", [verified]);
		}
		state = verified;
		if (signal.aborted) return finish("aborted");
		const terminalReason = firstTerminalReason ?? terminalPrReason(verified);
		if (terminalReason) {
			notify(`PR #${prNumber} is not ready: ${terminalReason}.`, "warning");
			return finish("incomplete", [terminalReason]);
		}

		const ready = isMergeReady(verified);
		if (ready) {
			notify(`PR #${prNumber} looks merge-ready after a fresh status read.`, "info");
		} else {
			notify(`PR #${prNumber} is not ready: ${describeBlockers(verified)}.`, "warning");
		}
		return finish(ready ? "merge-ready" : "incomplete", ready ? [] : [describeBlockers(verified)]);
	}

	if (mode === "cleanup") {
		setPhase("cleaning");
		const ok = await runCleanup(backend, cwd, confirm, notify, signal);

		if (signal.aborted) return finish("aborted");
		return finish(ok ? "cleaned" : "blocked", ok ? [] : ["cleanup not confirmed"]);
	}

	let verifiedHeadSha: string | null = null;
	let mergeabilityPolls = 0;
	const maxCycles = maxFixCycles(mode);
	const loaded = await ops.loadPersistedState(repoKey, prNumber);
	let persisted = loaded.state;
	const migrationNote = loaded.kind === "ready" ? loaded.migrationNote : undefined;
	const reviewMutationBlocker = loaded.kind === "blocked" ? loaded.reviewMutationBlocker : undefined;
	if (migrationNote) {
		notify(migrationNote, "warning");
		await ops.savePersistedState(persisted);
	}
	if (reviewMutationBlocker) notify(reviewMutationBlocker, "warning");

	const refresh = async (): Promise<PRState | string> => {
		setPhase("checking", cycle);
		const fetched = await fetchPRState(exec, cwd, prNumber, verifiedHeadSha, persisted, repoName, signal);
		if (signal.aborted || isString(fetched) || reviewMutationBlocker) return fetched;
		const reconciled = reconcileLegacyPendingReplyIds(persisted.legacyPendingReplyIds, fetched.threads);
		if (reconciled.length !== persisted.legacyPendingReplyIds.length) {
			persisted = { ...persisted, legacyPendingReplyIds: reconciled };
			await ops.savePersistedState(persisted);
		}
		return fetched;
	};

	const runChild = async (
		role: "triager" | "fixer",
		task: string,
	): Promise<Awaited<ReturnType<DriverOps["runChildRole"]>>> => {
		if (signal.aborted) return { ok: false, error: "aborted by user", usage: emptyUsage() };
		const taskFile = join(promptDir, `${role}-${cycle + 1}.md`);
		await writeFile(taskFile, task, { mode: 0o600 });
		if (signal.aborted) return { ok: false, error: "aborted by user", usage: emptyUsage() };
		const result = await ops.runChildRole(
			role,
			{
				model: selected.model,
				thinking: selected.thinking,
				promptFile: role === "triager" ? triagerPromptFile : fixerPromptFile,
				taskFile,
				timeoutMinutes: config.timeoutMinutes,
				maxRuntimeMinutes: config.maxRuntimeMinutes,
			},
			{ cwd, signal },
		);
		accumulateUsage(result.usage);
		return result;
	};

	const declareReady = async (
		snapshot: PRState,
	): Promise<Pick<AutopilotResult, "status" | "blockedReasons"> | undefined> => {
		state = snapshot;
		if (signal.aborted) return { status: "aborted", blockedReasons };
		const terminalReason = terminalPrReason(snapshot);
		if (terminalReason) return { status: "incomplete", blockedReasons: [terminalReason] };
		if (!isCodeReady(snapshot)) return undefined;
		if (snapshot.isDraft || snapshot.mergeStateStatus === "DRAFT") {
			const mark = await confirm(
				`PR #${prNumber} is code-ready but still a draft. Mark it ready for review?`,
				"The autopilot will not merge. Marking ready is a PR state change and needs your say.",
			);
			if (signal.aborted) return { status: "aborted", blockedReasons };
			if (!mark) {
				blockedReasons.push("code-ready but still a draft (mark-ready not confirmed)");
				return { status: "incomplete", blockedReasons };
			}
			const readyResult = await markPrReady(exec, cwd, prNumber);
			if (readyResult.code !== 0) {
				blockedReasons.push(`could not mark ready: ${readyResult.stderr.trim()}`);
				return { status: "blocked", blockedReasons };
			}
			if (signal.aborted) return { status: "aborted", blockedReasons };
		}
		setPhase("settling", cycle);
		const settled = await fetchPRState(exec, cwd, prNumber, snapshot.headSha, persisted, repoName, signal);
		if (signal.aborted) return { status: "aborted", blockedReasons };
		if (isString(settled)) {
			notify(settled, "error");
			return { status: "failed", blockedReasons: [settled] };
		}
		state = settled;
		if (signal.aborted) return { status: "aborted", blockedReasons };
		const settledTerminalReason = terminalPrReason(settled);
		if (settledTerminalReason) return { status: "incomplete", blockedReasons: [settledTerminalReason] };
		const headMoved = settled.headSha !== snapshot.headSha;
		if (!headMoved && isMergeReady(settled)) {
			notify(`PR #${prNumber} looks merge-ready after a fresh status read. Not merging.`, "info");
			return { status: "merge-ready", blockedReasons: [] };
		}
		const headVerificationPending =
			settled.verifiedHeadSha !== settled.headSha && isMergeReadyIgnoringHeadVerification(settled);
		if (!isMergeabilityPending(settled) && !headVerificationPending) {
			if (headMoved) {
				notify(
					`PR #${prNumber} advanced from ${snapshot.headSha.slice(0, 8)} to ${settled.headSha.slice(0, 8)} during verification; rechecking.`,
					"warning",
				);
			} else {
				notify(
					`PR #${prNumber} looked ready, then the settle re-read showed: ${describeBlockers(settled)}.`,
					"warning",
				);
			}
			return undefined;
		}
		if (headMoved) {
			notify(
				`PR #${prNumber} advanced from ${snapshot.headSha.slice(0, 8)} to ${settled.headSha.slice(0, 8)} while readiness was settling; verifying the new head.`,
				"warning",
			);
		}
		if (mode === "threads") {
			const reason = describeBlockers(settled);
			notify(`PR #${prNumber} is not ready: ${reason}.`, "warning");
			return { status: "incomplete", blockedReasons: [reason] };
		}

		let previousHeadSha = settled.headSha;
		while (mergeabilityPolls < MERGEABILITY_POLL_LIMIT) {
			try {
				await ops.sleep(MERGEABILITY_POLL_DELAY_MS, signal);
			} catch (error) {
				if (signal.aborted) return { status: "aborted", blockedReasons };
				const reason = `Could not wait for mergeability: ${error instanceof Error ? error.message : String(error)}`;
				notify(reason, "error");
				return { status: "failed", blockedReasons: [reason] };
			}
			if (signal.aborted) return { status: "aborted", blockedReasons };
			mergeabilityPolls++;
			const next = await fetchPRState(exec, cwd, prNumber, previousHeadSha, persisted, repoName, signal);
			if (isString(next)) {
				notify(next, "error");
				return { status: "failed", blockedReasons: [next] };
			}
			state = next;
			if (signal.aborted) return { status: "aborted", blockedReasons };
			const polledTerminalReason = terminalPrReason(next);
			if (polledTerminalReason) {
				notify(`PR #${prNumber} is not ready: ${polledTerminalReason}.`, "warning");
				return { status: "incomplete", blockedReasons: [polledTerminalReason] };
			}
			if (next.headSha !== previousHeadSha) {
				notify(
					`PR #${prNumber} advanced from ${previousHeadSha.slice(0, 8)} to ${next.headSha.slice(0, 8)} while mergeability was settling; verifying the new head.`,
					"warning",
				);
			}
			if (isMergeReady(next)) {
				notify(`PR #${prNumber} looks merge-ready after mergeability settled. Not merging.`, "info");
				return { status: "merge-ready", blockedReasons: [] };
			}
			const onlyHeadVerificationPending =
				next.verifiedHeadSha !== next.headSha && isMergeReadyIgnoringHeadVerification(next);
			if (!isMergeabilityPending(next) && !onlyHeadVerificationPending) {
				notify(`PR #${prNumber} changed while mergeability was settling: ${describeBlockers(next)}.`, "warning");
				return undefined;
			}
			previousHeadSha = next.headSha;
		}

		const reason = `mergeability pending after ${MERGEABILITY_POLL_LIMIT} additional observations`;
		notify(`PR #${prNumber} is not ready: ${reason}.`, "warning");
		return { status: "incomplete", blockedReasons: [reason] };
	};

	while (cycle < maxCycles) {
		if (signal.aborted) return finish("aborted");

		const fetched = await refresh();
		if (signal.aborted) return finish("aborted");
		if (isString(fetched)) {
			notify(fetched, "error");
			return finish("failed", [fetched]);
		}
		state = fetched;
		if (signal.aborted) return finish("aborted");
		const terminalReason = terminalPrReason(state);
		if (terminalReason) {
			notify(`PR #${prNumber} is not ready: ${terminalReason}.`, "warning");
			return finish("incomplete", [terminalReason]);
		}
		notify(
			`PR #${prNumber} — ${describeBlockers(state) === "unknown blocker" && isCodeReady(state) ? "code-ready" : describeBlockers(state)} (sha ${state.headSha.slice(0, 8)})`,
			"info",
		);

		const hasUntriagedDiscussion = state.threads.some((thread) => thread.source === "issue-comment");
		const ready = hasUntriagedDiscussion ? undefined : await declareReady(state);
		if (ready) return finish(ready.status, ready.blockedReasons);
		const liveLegacyPending = state.threads
			.filter((thread) => thread.source === "review-thread")
			.filter((thread) => persisted.legacyPendingReplyIds.includes(thread.id))
			.map((thread) => thread.id);
		if (liveLegacyPending.length > 0) {
			const reason = `Legacy pending replies need inspection before mutation: ${liveLegacyPending.join(", ")}`;
			notify(reason, "warning");
			blockedReasons.push(reason);
			break;
		}

		if (
			state.mergeable === "conflicting" ||
			state.mergeStateStatus === "DIRTY" ||
			state.mergeStateStatus === "BEHIND"
		) {
			setPhase("merging-base", cycle);
			const remoteBase = policy.remoteBaseDisplay(state.baseRef);
			notify(
				`PR #${prNumber} is ${state.mergeStateStatus === "BEHIND" ? "behind" : "conflicted"} against ${state.baseRef}. Applying the backend's ${policy.baseUpdateVerb} update from ${remoteBase}. ${policy.baseUpdateDisclosure}`,
				"info",
			);
			const updated = await mutation.updateBaseAndPublish(cwd, {
				prNumber,
				headRef: state.headRef,
				headSha: state.headSha,
				baseRef: state.baseRef,
			});
			switch (updated.kind) {
				case "cancelled":
					return finish("aborted", blockedReasons, updated.completedActions);
				case "precondition-failed":
					notify(updated.error, "error");
					return finish("blocked", [updated.error]);
				case "already-current":
					notify(`${remoteBase} is already in the current workstream; refreshing GitHub state.`, "info");
					cycle++;
					continue;
				case "published":
					notify(
						`Applied the ${policy.baseUpdateVerb} update from ${remoteBase} and published ${updated.headSha.slice(0, 8)}.`,
						"info",
					);
					verifiedHeadSha = null;
					persisted = { ...persisted, headSha: updated.headSha };
					if (!reviewMutationBlocker) await ops.savePersistedState(persisted);
					cycle++;
					continue;
				case "needs-human":
				case "failed":
					notify(updated.error, "error");
					blockedReasons.push(updated.error);
					break;
				default: {
					const _exhaustive: never = updated;
					return _exhaustive;
				}
			}
			break;
		}

		if (hasPendingChecks(state) && !hasFailingChecks(state) && !state.hasUnresolvedThreads) {
			setPhase("watching", cycle);
			notify(
				`PR #${prNumber}: nothing actionable and checks are still running. Watching CI instead of inventing work.`,
				"info",
			);
			const watched = await watchChecks(exec, cwd, prNumber, LIMITS.watchTimeoutMinutes * 60_000, signal);
			if (signal.aborted) return finish("aborted");
			if (watched.code !== 0) {
				notify(`CI watch ended: ${watched.stderr.trim() || "a check failed or the watch timed out"}.`, "warning");
			}
			const afterWatch = await refresh();
			if (signal.aborted) return finish("aborted");
			if (isString(afterWatch)) {
				notify(afterWatch, "error");
				return finish("failed", [afterWatch]);
			}
			state = afterWatch;
			if (signal.aborted) return finish("aborted");
			const terminalReasonAfterWatch = terminalPrReason(state);
			if (terminalReasonAfterWatch) return finish("incomplete", [terminalReasonAfterWatch]);
			if (hasPendingChecks(state) && !hasFailingChecks(state) && !state.hasUnresolvedThreads) {
				blockedReasons.push("CI still pending after watch");
				blockedCodes.push("ci-pending-after-watch");
				break;
			}
			continue;
		}

		setPhase("triaging", cycle);
		if (signal.aborted) return finish("aborted");
		const checksWithLogs = await attachFailedLogs(exec, cwd, state.checks, config.maxConcurrency);
		if (signal.aborted) return finish("aborted");
		state = { ...state, checks: checksWithLogs };
		const triagerResult = await runChild("triager", buildTriagerTask(state, backend.id));
		if (signal.aborted) return finish("aborted");
		if (!triagerResult.ok) {
			notify(`Triager failed: ${triagerResult.error}`, "error");
			blockedReasons.push(triagerResult.error);
			break;
		}
		const parsedRaw = parseTriage(triagerResult.output);
		if ("error" in parsedRaw) {
			notify(`Triage parse failed: ${parsedRaw.error}`, "error");
			blockedReasons.push(parsedRaw.error);
			break;
		}
		const parsed = applyTriageGuardrails(state, parsedRaw);
		notify(`Cause: ${parsed.summary || summarizeTriage(triagerResult.output)}`, "info");

		const askThreads = parsed.threads.flatMap((thread) => {
			if (thread.decision !== "ask" || !state) return [];
			const source = threadForTriageKey(state, thread.key);
			return source ? [{ action: thread.action, source }] : [];
		});
		if (askThreads.length > 0) {
			const lines = askThreads.map(
				({ action, source }) => `- ${source.id}${source.path ? ` ${source.path}` : ""}: ${action}`,
			);
			notify(`Ask (not guessing): ${lines.join("; ")}`, "error");
			blockedReasons.push(`ask threads: ${askThreads.map(({ source }) => source.id).join(", ")}`);
		}
		if (reviewMutationBlocker && parsed.threads.some((thread) => thread.decision !== "ask")) {
			blockedReasons.push(reviewMutationBlocker);
			break;
		}
		const flakeKey = (name: string) => `${name}@${state?.headSha ?? ""}`;
		const flakeChecks = parsed.checks.flatMap((classification) => {
			if (classification.cls !== "flake" || !state) return [];
			const check = checkForTriageKey(state, classification.key);
			return check ? [check] : [];
		});
		const newFlakes = flakeChecks.filter((check) => !persisted.flakeRetried.includes(flakeKey(check.name)));
		if (newFlakes.length > 0 && state) {
			let reran = false;
			for (const check of newFlakes) {
				if (signal.aborted) return finish("aborted");
				if (!check.runId) continue;
				const rerun = await rerunFailedRun(exec, cwd, check.runId);
				persisted = { ...persisted, flakeRetried: [...persisted.flakeRetried, flakeKey(check.name)] };
				if (rerun.code !== 0) {
					notify(`Could not rerun ${check.name}: ${rerun.stderr.trim()}`, "warning");
				} else {
					notify(`Cause: flake on ${check.name}. Reran failed jobs once on SHA ${state.headSha.slice(0, 8)}.`, "info");
					reran = true;
				}
				if (signal.aborted) {
					if (!reviewMutationBlocker) await ops.savePersistedState(persisted);
					return finish("aborted");
				}
			}
			if (!reviewMutationBlocker) await ops.savePersistedState(persisted);
			if (reran) {
				cycle++;
				continue;
			}
		}

		const staleOrInfra = parsed.checks.filter(
			(c) => c.cls === "stale-base" || c.cls === "infra" || c.cls === "unknown",
		);
		const codeChecks = parsed.checks.filter((c) => c.cls === "code");
		const fixThreads = parsed.threads.filter((t) => t.decision === "fix");
		const hasCommentWork = parsed.threads.some((thread) => thread.decision !== "ask");

		const commentsFirst = mode === "threads" || hasCommentWork;
		const fixMode: FixMode =
			mode === "threads"
				? "threads"
				: commentsFirst && codeChecks.length > 0
					? "threads"
					: codeChecks.length > 0
						? "ci"
						: "threads";

		if (!hasCommentWork && codeChecks.length === 0) {
			if (askThreads.length > 0) break;
			if (staleOrInfra.length > 0) {
				blockedReasons.push(
					staleOrInfra
						.map((classification) => {
							const check = state ? checkForTriageKey(state, classification.key) : undefined;
							return `${check?.name ?? classification.key}: ${classification.cls} (${classification.action})`;
						})
						.join("; "),
				);
				break;
			}
			blockedReasons.push("triage found nothing the autopilot can fix");
			break;
		}

		let fixerOutput = "";
		let pushedAFix = false;
		if (fixThreads.length > 0 || (fixMode === "ci" && codeChecks.length > 0)) {
			setPhase("fixing", cycle);
			// The fixer edits the PR workspace, so validate the checkout only now.
			const opened = await mutation.openCheckout(cwd, {
				prNumber,
				headRef: state.headRef,
				headSha: state.headSha,
			});
			if (signal.aborted) return finish("aborted");
			if (!opened.ok) {
				notify(opened.error, "error");
				return finish("blocked", [opened.error]);
			}
			const fixerResult = await runChild("fixer", buildFixerTask(state, JSON.stringify(parsed), fixMode, backend.id));
			if (signal.aborted) return finish("aborted");
			if (!fixerResult.ok) {
				notify(`Fixer failed: ${fixerResult.error}`, "error");
				blockedReasons.push(fixerResult.error);
				break;
			}
			fixerOutput = fixerResult.output;

			setPhase("pushing", cycle);
			const confirmed = await confirm(
				`Push fixes to PR #${prNumber}?`,
				`Cycle ${cycle + 1} fixer (${selected.label}) completed.\n` +
					`Integrating the remote PR head, recording only touched paths with ${backend.id}, then publishing ${opened.checkout.affectedRefs.join(", ")}.\n` +
					policy.fixPublicationDisclosure,
			);
			if (signal.aborted) return finish("aborted");
			if (!confirmed) {
				notify("Push not confirmed. Stopping.", "info");
				return finish("incomplete", ["push not confirmed"]);
			}
			const pushResult = /\bVERIFY_FAIL\b/.test(fixerOutput)
				? {
						kind: "failed" as const,
						error: "Fixer reported VERIFY_FAIL — not pushing a fix that failed its own checks.",
					}
				: await mutation.publishFix(cwd, opened.checkout, {
						message: `Autopilot PR #${prNumber}: address review threads and CI failures\n\nCo-authored-by: pr-autopilot (child agents)`,
						isForbiddenPath: isForbiddenStagingPath,
					});
			switch (pushResult.kind) {
				case "unchanged":
					notify("Fixer found nothing to commit. Skipping push.", "warning");
					break;
				case "cancelled":
					return finish("aborted", blockedReasons, pushResult.completedActions);
				case "failed":
					notify(`Push failed: ${pushResult.error}`, "error");
					blockedReasons.push(`push failed: ${pushResult.error}`);
					break;
				case "pushed":
					notify(
						`Pushed to ${state.headRef} (new HEAD: ${pushResult.headSha?.slice(0, 8) ?? "?"}). Prior CI on the old SHA is stale.`,
						"info",
					);
					verifiedHeadSha = null;
					persisted = { ...persisted, headSha: pushResult.headSha ?? "" };
					pushedAFix = true;
					break;
			}
			if (pushResult.kind === "failed") break;
		}

		setPhase("replying", cycle);
		const replyResult = await applyThreadReplies(
			exec,
			cwd,
			state,
			parsed,
			{
				resolveFix: pushedAFix,
				pendingReviewReplies: persisted.pendingReviewReplies,
				legacyPendingReplyIds: persisted.legacyPendingReplyIds,
				reviewMutationBlocker,
				repo: repoName,
			},
			notify,
			signal,
		);
		persisted = {
			...persisted,
			handled: appendHandledReviewRecords(persisted.handled, replyResult.handled),
			pendingReviewReplies: replyResult.pendingReviewReplies,
		};
		if (!reviewMutationBlocker) await ops.savePersistedState(persisted);
		if (!replyResult.ok) blockedReasons.push(replyResult.error);
		if (signal.aborted) return finish("aborted");
		if (!replyResult.ok) break;
		if (replyResult.handled.length > 0) {
			notify(`Handled ${replyResult.handled.length} review item(s).`, "info");
		}

		if (mode === "threads") {
			cycle++;
			const recheck = await refresh();
			if (signal.aborted) return finish("aborted");
			if (isString(recheck)) {
				return finish("incomplete", [recheck]);
			}
			state = recheck;
			if (signal.aborted) return finish("aborted");
			const done = await declareReady(recheck);
			if (done) return finish(done.status, done.blockedReasons);
			notify(`PR #${prNumber} still not ready after threads: ${describeBlockers(recheck)}.`, "warning");
			return finish("incomplete", [describeBlockers(recheck)]);
		}

		if (askThreads.length > 0 && fixThreads.length === 0 && codeChecks.length === 0) {
			break;
		}

		cycle++;
	}

	if (!signal.aborted && blockedReasons.length === 0) blockedReasons.push("max cycles reached without merge-ready");
	return finish("blocked");
}
