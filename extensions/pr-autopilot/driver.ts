import { isString } from "../shared/validation.ts";
/**
 * Bounded PR autopilot state machine.
 *
 * One PR at a time, lowest unmerged first. Tiny models only. The loop:
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
 *   check    — one status pass, report, stop.
 *   threads  — address review threads only, then push.
 *   drive    — loop until merge-ready or a hard blocker (3 fix cycles).
 *   watch    — same as drive with more cycles, watching CI between ticks.
 *   cleanup  — remove the managed worktree and branch after confirmation.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveRepoName } from "../shared/github.ts";
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
import { isForbiddenStagingPath, markPrReady, rerunFailedRun, watchChecks } from "./github.ts";
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
	isMergeReady,
	pickModel,
	resolveTargetPR,
} from "./pr-state.ts";
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
}

const defaultOps: DriverOps = { runChildRole, loadPersistedState, savePersistedState };

export async function runAutopilot(
	mode: AutopilotMode,
	params: {
		config: ResolvedAutopilotConfig;
		exec: ExecFn;
		backend: VcsBackend;
		cwd: string;
		explicitPR?: number;
		promptDir: string;
		triagerPromptFile: string;
		fixerPromptFile: string;
		/** One tiny model for every child in this run. Chosen before confirmation. */
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
	const mutation = createPrMutation(backend);
	let usage = emptyUsage();
	const blockedReasons: string[] = [];
	const blockedCodes: NonNullable<AutopilotResult["blockedCodes"]> = [];

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
	if (mode !== "check") {
		const preflight = await backend.preflight(cwd);
		if (!preflight.ok) {
			notify(preflight.error, "error");
			return {
				status: "blocked",
				mergeReady: false,
				cyclesCompleted: 0,
				blockedReasons: [preflight.error],
				usage,
			};
		}
	}
	const target = await resolveTargetPR(exec, cwd, params.explicitPR);
	if (target.error || !target.prNumber) {
		const msg = target.error ?? "No PR to drive.";
		notify(msg, "error");
		return { status: "blocked", mergeReady: false, cyclesCompleted: 0, blockedReasons: [msg], usage };
	}
	const prNumber = target.prNumber;
	const repoKey = repoPersistKey(cwd);
	let repoName: Promise<string | undefined> | undefined;
	const resolveRepoOnce = () => (repoName ??= resolveRepoName(exec, cwd));
	const selected = params.selectedModel ?? pickModel(config.models);
	notify(`Driving PR #${prNumber} in ${mode} mode. Model: ${selected.label}`, "info");

	if (mode === "check") {
		setPhase("checking");
		const persisted = await ops.loadPersistedState(repoKey, prNumber);
		const state = await fetchPRState(
			exec,
			cwd,
			prNumber,
			null,
			{
				concurrency: config.maxConcurrency,
				handledThreadIds: persisted.handledThreadIds,
			},
			await resolveRepoOnce(),
		);
		setPhase("idle");
		if (isString(state)) {
			notify(state, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: 0, blockedReasons: [state], usage };
		}
		const verified = await fetchPRState(
			exec,
			cwd,
			prNumber,
			state.headSha,
			{
				concurrency: config.maxConcurrency,
				handledThreadIds: persisted.handledThreadIds,
			},
			await resolveRepoOnce(),
		);
		if (isString(verified)) {
			return { status: "failed", mergeReady: false, cyclesCompleted: 0, blockedReasons: [verified], usage };
		}
		setPhase("idle");
		const ready = isMergeReady(verified);
		if (ready) {
			notify(`PR #${prNumber} looks merge-ready after a fresh status read.`, "info");
		} else {
			notify(`PR #${prNumber} is not ready: ${describeBlockers(verified)}.`, "warning");
		}
		return {
			status: ready ? "merge-ready" : "incomplete",
			prState: verified,
			mergeReady: ready,
			cyclesCompleted: 0,
			blockedReasons: ready ? [] : [describeBlockers(verified)],
			usage,
		};
	}

	if (mode === "cleanup") {
		setPhase("cleaning");
		const ok = await runCleanup(backend, cwd, confirm, notify);
		setPhase("idle");
		return {
			status: ok ? "cleaned" : "blocked",
			mergeReady: false,
			cyclesCompleted: 0,
			blockedReasons: ok ? [] : ["cleanup not confirmed"],
			usage,
		};
	}

	let state: PRState | null = null;
	let verifiedHeadSha: string | null = null;
	let cycle = 0;
	const maxCycles = maxFixCycles(mode);
	let persisted = await ops.loadPersistedState(repoKey, prNumber);

	const refresh = async (): Promise<PRState | string> => {
		setPhase("checking", cycle);
		return fetchPRState(
			exec,
			cwd,
			prNumber,
			verifiedHeadSha,
			{
				concurrency: config.maxConcurrency,
				handledThreadIds: persisted.handledThreadIds,
			},
			await resolveRepoOnce(),
		);
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
				return {
					status: "incomplete",
					prState: snapshot,
					mergeReady: false,
					cyclesCompleted: cycle,
					blockedReasons: [...blockedReasons],
					usage,
				};
			}
			const readyResult = await markPrReady(exec, cwd, prNumber);
			if (readyResult.code !== 0) {
				blockedReasons.push(`could not mark ready: ${readyResult.stderr.trim()}`);
				return {
					status: "blocked",
					prState: snapshot,
					mergeReady: false,
					cyclesCompleted: cycle,
					blockedReasons: [...blockedReasons],
					usage,
				};
			}
		}
		setPhase("settling", cycle);
		const settled = await fetchPRState(
			exec,
			cwd,
			prNumber,
			snapshot.headSha,
			{
				concurrency: config.maxConcurrency,
				handledThreadIds: persisted.handledThreadIds,
			},
			await resolveRepoOnce(),
		);
		if (isString(settled)) {
			notify(settled, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [settled], usage };
		}
		if (settled.headSha !== snapshot.headSha) {
			notify(
				`PR #${prNumber} advanced from ${snapshot.headSha.slice(0, 8)} to ${settled.headSha.slice(0, 8)} during verification; rechecking.`,
				"warning",
			);
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
		return {
			status: "merge-ready",
			prState: settled,
			mergeReady: true,
			cyclesCompleted: cycle,
			blockedReasons: [],
			usage,
		};
	};

	while (cycle < maxCycles) {
		if (signal.aborted) {
			return {
				status: "aborted",
				mergeReady: false,
				cyclesCompleted: cycle,
				blockedReasons: ["aborted by user"],
				usage,
			};
		}

		const fetched = await refresh();
		if (isString(fetched)) {
			notify(fetched, "error");
			return { status: "failed", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [fetched], usage };
		}
		state = fetched;
		notify(
			`PR #${prNumber} — ${describeBlockers(state) === "unknown blocker" && isCodeReady(state) ? "code-ready" : describeBlockers(state)} (sha ${state.headSha.slice(0, 8)})`,
			"info",
		);

		const hasUntriagedDiscussion = state.threads.some((thread) => thread.source === "issue-comment");
		const ready = hasUntriagedDiscussion ? undefined : await declareReady(state);
		if (ready) return ready;

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
				case "precondition-failed":
					notify(updated.error, "error");
					return {
						status: "blocked",
						prState: state,
						mergeReady: false,
						cyclesCompleted: cycle,
						blockedReasons: [updated.error],
						usage,
					};
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
					await ops.savePersistedState(persisted);
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
			if (signal.aborted) {
				return {
					status: "aborted",
					mergeReady: false,
					cyclesCompleted: cycle,
					blockedReasons: ["aborted by user"],
					usage,
				};
			}
			if (watched.code !== 0) {
				notify(`CI watch ended: ${watched.stderr.trim() || "a check failed or the watch timed out"}.`, "warning");
			}
			const afterWatch = await refresh();
			if (isString(afterWatch)) {
				notify(afterWatch, "error");
				return { status: "failed", mergeReady: false, cyclesCompleted: cycle, blockedReasons: [afterWatch], usage };
			}
			state = afterWatch;
			if (hasPendingChecks(state) && !hasFailingChecks(state) && !state.hasUnresolvedThreads) {
				blockedReasons.push("CI still pending after watch");
				blockedCodes.push("ci-pending-after-watch");
				break;
			}
			continue;
		}

		setPhase("triaging", cycle);
		const taskFile = join(promptDir, `triager-${cycle + 1}.md`);
		await writeFile(taskFile, buildTriagerTask(state, backend.id), { mode: 0o600 });
		const triagerResult = await ops.runChildRole(
			"triager",
			{
				model: selected.model,
				thinking: selected.thinking,
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
				if (!check.runId) continue;
				const rerun = await rerunFailedRun(exec, cwd, check.runId);
				persisted = { ...persisted, flakeRetried: [...persisted.flakeRetried, flakeKey(check.name)] };
				if (rerun.code === 0) {
					notify(`Cause: flake on ${check.name}. Reran failed jobs once on SHA ${state.headSha.slice(0, 8)}.`, "info");
					reran = true;
				} else {
					notify(`Could not rerun ${check.name}: ${rerun.stderr.trim()}`, "warning");
				}
			}
			await ops.savePersistedState(persisted);
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
			if (!opened.ok) {
				notify(opened.error, "error");
				return {
					status: "blocked",
					prState: state,
					mergeReady: false,
					cyclesCompleted: cycle,
					blockedReasons: [opened.error],
					usage,
				};
			}
			const fixerTaskFile = join(promptDir, `fixer-${cycle + 1}.md`);
			await writeFile(fixerTaskFile, buildFixerTask(state, JSON.stringify(parsed), fixMode, backend.id), {
				mode: 0o600,
			});
			const fixerResult = await ops.runChildRole(
				"fixer",
				{
					model: selected.model,
					thinking: selected.thinking,
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
				`Cycle ${cycle + 1} fixer (${selected.label}) completed.\n` +
					`Integrating the remote PR head, recording only touched paths with ${backend.id}, then publishing ${opened.checkout.affectedRefs.join(", ")}.\n` +
					policy.fixPublicationDisclosure,
			);
			if (!confirmed) {
				notify("Push not confirmed. Stopping.", "info");
				return {
					status: "incomplete",
					mergeReady: false,
					cyclesCompleted: cycle,
					blockedReasons: ["push not confirmed"],
					usage,
				};
			}
			const pushResult = /\bVERIFY_FAIL\b/.test(fixerOutput)
				? {
						kind: "failed" as const,
						error: "Fixer reported VERIFY_FAIL — not pushing a fix that failed its own checks.",
					}
				: await mutation.publishFix(cwd, opened.checkout, {
						message: `Autopilot PR #${prNumber}: address review threads and CI failures\n\nCo-authored-by: pr-autopilot (tiny models)`,
						isForbiddenPath: isForbiddenStagingPath,
					});
			switch (pushResult.kind) {
				case "unchanged":
					notify("Fixer found nothing to commit. Skipping push.", "warning");
					break;
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
		const repliedThreadIds = [...persisted.repliedThreadIds];
		const replyResult = await applyThreadReplies(
			exec,
			cwd,
			state,
			parsed,
			{ resolveFix: pushedAFix, repliedThreadIds },
			notify,
		);
		persisted = {
			...persisted,
			handledThreadIds: [...persisted.handledThreadIds, ...replyResult.handled],
			repliedThreadIds: repliedThreadIds.filter((id) => !replyResult.handled.includes(id)),
		};
		await ops.savePersistedState(persisted);
		if (!replyResult.ok) {
			blockedReasons.push(replyResult.error);
			break;
		}
		if (replyResult.handled.length > 0) {
			notify(`Handled ${replyResult.handled.length} review item(s).`, "info");
		}

		if (mode === "threads") {
			const recheck = await refresh();
			setPhase("idle", cycle + 1);
			if (isString(recheck)) {
				return {
					status: "incomplete",
					mergeReady: false,
					cyclesCompleted: cycle + 1,
					blockedReasons: [recheck],
					usage,
				};
			}
			const done = await declareReady(recheck);
			if (done) return done;
			notify(`PR #${prNumber} still not ready after threads: ${describeBlockers(recheck)}.`, "warning");
			return {
				status: "incomplete",
				prState: recheck,
				mergeReady: false,
				cyclesCompleted: cycle + 1,
				blockedReasons: [describeBlockers(recheck)],
				usage,
			};
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
		blockedCodes,
		usage,
	};
}
