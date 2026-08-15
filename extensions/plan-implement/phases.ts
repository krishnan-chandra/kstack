/** Deterministic plan/implement phase runners with UI and lifecycle effects injected. */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandResult } from "../land/types.ts";
import type { PanelArgs, PanelReviewOutcome } from "../panel-review/types.ts";
import type { AutopilotResult } from "../pr-autopilot/driver.ts";
import {
	createCurrentWorkstreamBranch,
	verifyCommittedWorkstream,
	type WorkstreamCheckpoint,
} from "../shared/git-policy.ts";
import { createManagedWorktree, type ManagedWorktreePlan } from "../shared/worktree.ts";
import { runAgent } from "./agent-runner.ts";
import { buildPanelReviewOptions, buildStackPanelReviewOptions } from "./command.ts";
import type { ExecFn } from "./delivery-mode.ts";
import { createExecutionLedger, extractExecutionLedger, validateExecutionLedger } from "./execution-ledger.ts";
import type { WorkflowPhase } from "./lifecycle.ts";
import type { AgentRole, AgentRunResult, DeliveryMode, WorkLocation } from "./types.ts";
import { runWorkflow } from "./workflow.ts";

type Level = "info" | "warning" | "error";

export interface PhaseEffects {
	runAgent?: typeof runAgent;
	confirm(title: string, body: string): Promise<boolean>;
	notify(message: string, level: Level): void;
	setStatus(status: string | undefined): void;
	sendPhase(result: AgentRunResult): void;
	isCurrent(): boolean;
	isSessionCurrent(): boolean;
	beginChild(phase: Exclude<WorkflowPhase, "idle" | "approval">): AbortController | undefined;
	endChild(controller: AbortController): void;
	exec: ExecFn;
	requestPanelReview(options: PanelArgs): Promise<{ handled: false } | { handled: true; outcome: PanelReviewOutcome }>;
	resolvePublishedPr(cwd: string): Promise<{ ok: true; prNumber: number } | { ok: false; error: string }>;
	requestLand(prNumber: number, cwd: string): Promise<{ handled: false } | { handled: true; outcome: LandResult }>;
	requestAutopilot(
		prNumber: number,
		cwd: string,
	): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }>;
}

export interface ApprovedWorkflowOptions {
	task: string;
	mode: DeliveryMode;
	workLocation: WorkLocation;
	initialCwd: string;
	promptsDir: string;
	plannerModel: string;
	implementerModel: string;
	timeoutMinutes: number;
	skillPaths: string[];
	changePrompts: string[];
	trunkSha?: string;
	worktreePlan?: ManagedWorktreePlan;
}

export function phaseErrorText(result: AgentRunResult): string {
	if (result.status === "failed") return result.error;
	if (result.status === "aborted") return `${result.role} was aborted.`;
	return result.output;
}

function removePrivateDir(dir: string | undefined, label: string, fx: PhaseEffects): void {
	if (!dir) return;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		const message = `Could not remove private ${label} temp directory ${dir}; remove it manually.`;
		if (fx.isSessionCurrent()) fx.notify(message, "warning");
		else console.error(`plan-implement: ${message}`);
	}
}

export async function runPostReviewPhases(
	verdict: string,
	options: ApprovedWorkflowOptions,
	state: { workflowCwd: string; workstreamCheckpoint?: WorkstreamCheckpoint },
	fx: PhaseEffects,
): Promise<void> {
	const { task, mode, workLocation, promptsDir, implementerModel, timeoutMinutes, skillPaths, changePrompts } = options;
	const timeoutMs = timeoutMinutes * 60_000;
	const executeAgent = fx.runAgent ?? runAgent;
	let reviewDir: string | undefined;
	try {
		reviewDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-review-"));
		const taskFile = join(reviewDir, "task.md");
		const verdictFile = join(reviewDir, "panel-verdict.md");
		writeFileSync(taskFile, `# User task\n\n${task}\n`, { encoding: "utf8", mode: 0o600 });
		writeFileSync(verdictFile, `# Panel-review verdict\n\n${verdict}\n`, { encoding: "utf8", mode: 0o600 });

		const fixConfirmed = await fx.confirm(
			"Address panel-review findings?",
			`Review fixer (commits verified fixes locally): ${implementerModel}\n` +
				`Timeout: ${timeoutMinutes} min\n\n` +
				"The fixer addresses the verdict's Act On findings (and small, clearly-correct Consider items), " +
				"verifies each against the repository, and re-runs focused tests. It commits verified fixes locally but does not push or publish.",
		);
		if (fx.isCurrent() && fixConfirmed) {
			const controller = fx.beginChild("fixing");
			if (controller) {
				try {
					fx.setStatus(`plan-implement: fixer ${implementerModel}…`);
					const fixer = await executeAgent({
						role: "fixer",
						model: implementerModel,
						promptFile: join(promptsDir, "review-fixer.md"),
						taskFile,
						verdictFile,
						cwd: state.workflowCwd,
						signal: controller.signal,
						deps: { timeoutMs },
						onProgress: ({ role, turns, activity }) =>
							fx.setStatus(`plan-implement: ${role} · ${turns} turn(s) · ${activity}`),
						mode,
						workLocation,
						skillPaths,
						supplementalPrompts: changePrompts,
					});
					if (fx.isCurrent()) {
						fx.sendPhase(fixer);
						if (fixer.status !== "completed") {
							fx.notify(
								`Review fixer did not complete: ${phaseErrorText(fixer)}`,
								fixer.status === "aborted" ? "info" : "error",
							);
							return;
						}
						if (mode === "single" && state.workstreamCheckpoint) {
							const verified = await verifyCommittedWorkstream(state.workflowCwd, fx.exec, {
								...state.workstreamCheckpoint,
								requireNewCommit: false,
							});
							if (!verified.ok) {
								fx.notify(`Review fixer postcondition failed: ${verified.error} Publication was not offered.`, "error");
								return;
							}
						}
					}
				} finally {
					fx.endChild(controller);
					if (fx.isCurrent()) fx.setStatus(undefined);
				}
			}
		}

		if (!fx.isCurrent()) return;
		const publishConfirmed = await fx.confirm(
			mode === "stack" ? "Publish the stack as draft PRs and find reviewers?" : "Create a draft PR and find reviewers?",
			`Publisher: ${implementerModel}\nTimeout: ${timeoutMinutes} min\n\n` +
				(mode === "stack"
					? "The publisher consults jj-stacked-prs to submit the local stack as draft PRs (publish_stack.py) and write-pr for each slice's title/body, then find-reviewers for 2–5 reviewer recommendations over the full stack. "
					: "The publisher consults write-pr to push the branch and create a DRAFT PR (or update an existing PR's title/body), then find-reviewers for 2–5 reviewer recommendations. ") +
				(mode === "single"
					? "After publishing, you will be offered PR-autopilot (watch CI, address threads, push fixes) and then landing. "
					: "") +
				"It never marks PRs ready, merges, or force-pushes; creating a PR grants the necessary push. Reviewer recommendations are printed to the session as the run's final output.",
		);
		if (!fx.isCurrent() || !publishConfirmed) return;
		const controller = fx.beginChild("publishing");
		if (!controller) return;
		let publisher: AgentRunResult | undefined;
		try {
			fx.setStatus(`plan-implement: publisher ${implementerModel}…`);
			publisher = await executeAgent({
				role: "publisher",
				model: implementerModel,
				promptFile: join(promptsDir, "publisher.md"),
				taskFile,
				verdictFile,
				cwd: state.workflowCwd,
				signal: controller.signal,
				deps: { timeoutMs },
				onProgress: ({ role, turns, activity }) =>
					fx.setStatus(`plan-implement: ${role} · ${turns} turn(s) · ${activity}`),
				mode,
				workLocation,
				skillPaths,
			});
			if (fx.isCurrent()) {
				fx.sendPhase(publisher);
				fx.notify(
					publisher.status === "completed"
						? "Publish phase complete; the draft PR and reviewer recommendations are in the Publisher card above."
						: `Publisher did not complete: ${phaseErrorText(publisher)}`,
					publisher.status === "completed" || publisher.status === "aborted" ? "info" : "error",
				);
			}
		} finally {
			fx.endChild(controller);
			if (fx.isCurrent()) fx.setStatus(undefined);
		}
		if (mode === "single" && publisher?.status === "completed" && fx.isCurrent()) {
			await offerAutopilotPhase(options, state, fx);
			await offerLandContinuation(options, state, fx);
		}
	} finally {
		removePrivateDir(reviewDir, "review-phase", fx);
	}
}

async function offerAutopilotPhase(
	options: Pick<ApprovedWorkflowOptions, "mode">,
	state: { workflowCwd: string },
	fx: PhaseEffects,
): Promise<void> {
	if (options.mode !== "single" || !fx.isCurrent()) return;
	const resolved = await fx.resolvePublishedPr(state.workflowCwd);
	if (!fx.isCurrent()) return;
	if (!resolved.ok) {
		fx.notify(`Autopilot not offered: ${resolved.error}`, "warning");
		return;
	}
	const confirmed = await fx.confirm(
		`Run PR-autopilot on PR #${resolved.prNumber}?`,
		"PR-autopilot watches CI, addresses review threads, and pushes fixes until merge-ready. " +
			"Uses tiny models only. You can also run this later with /pr-autopilot.",
	);
	if (!confirmed || !fx.isCurrent()) return;
	const result = await fx.requestAutopilot(resolved.prNumber, state.workflowCwd);
	if (!fx.isCurrent()) return;
	if (!result.handled) {
		fx.notify("PR-autopilot is not available; the pr-autopilot extension may not be loaded.", "warning");
		return;
	}
	const outcome = result.outcome;
	if (outcome.status === "merge-ready") {
		fx.notify(`PR-autopilot: merge-ready after ${outcome.cyclesCompleted} cycle(s).`, "info");
	} else if (outcome.status === "aborted" || outcome.status === "declined") {
		fx.notify(`PR-autopilot: ${outcome.status}.`, "info");
	} else {
		const reasons = outcome.blockedReasons.length > 0 ? ` — ${outcome.blockedReasons.join("; ")}` : "";
		fx.notify(`PR-autopilot: ${outcome.status}${reasons}`, "warning");
	}
}

export async function offerLandContinuation(
	options: Pick<ApprovedWorkflowOptions, "mode">,
	state: { workflowCwd: string },
	fx: PhaseEffects,
): Promise<void> {
	if (options.mode !== "single" || !fx.isCurrent()) return;
	const resolved = await fx.resolvePublishedPr(state.workflowCwd);
	if (!fx.isCurrent()) return;
	if (!resolved.ok) {
		fx.notify(`Landing not offered: ${resolved.error}`, "warning");
		return;
	}
	const confirmed = await fx.confirm(
		`Continue to landing PR #${resolved.prNumber}?`,
		`Optional final phase: /land runs pr-autopilot readiness in watch mode, then asks again before any merge.\n` +
			`PR: #${resolved.prNumber} (resolved from the workflow branch in ${state.workflowCwd})\n` +
			"Landing has its own exact-head confirmation; declining there still performs no merge.\n" +
			"Decline to finish plan-implement at the draft PR, as before.",
	);
	if (!confirmed || !fx.isCurrent()) return;
	const landed = await fx.requestLand(resolved.prNumber, state.workflowCwd);
	if (!fx.isCurrent()) return;
	if (!landed.handled) {
		fx.notify("Landing not started: the land extension is not loaded.", "warning");
		return;
	}
	const outcome = landed.outcome;
	const summary = outcome.blockers.length > 0 ? ` — ${outcome.blockers.join("; ")}` : "";
	fx.notify(
		`Landing ${outcome.status}${summary}`,
		["failed", "blocked", "partially-landed", "aborted"].includes(outcome.status) ? "warning" : "info",
	);
}

export async function runApprovedWorkflow(options: ApprovedWorkflowOptions, fx: PhaseEffects): Promise<void> {
	const {
		task,
		mode,
		workLocation,
		initialCwd,
		promptsDir,
		plannerModel,
		implementerModel,
		timeoutMinutes,
		skillPaths,
		changePrompts,
		trunkSha,
		worktreePlan,
	} = options;
	const timeoutMs = timeoutMinutes * 60_000;
	const executeAgent = fx.runAgent ?? runAgent;
	const state: { workflowCwd: string; workstreamCheckpoint?: WorkstreamCheckpoint } = {
		workflowCwd: initialCwd,
		workstreamCheckpoint: worktreePlan ? { branch: worktreePlan.branch, baseSha: worktreePlan.baseSha } : undefined,
	};
	const progress = ({ role, turns, activity }: { role: AgentRole; turns: number; activity: string }) => {
		if (fx.isCurrent()) fx.setStatus(`plan-implement: ${role} · ${turns} turn(s) · ${activity}`);
	};
	let tempDir: string | undefined;
	let reviewOptions: PanelArgs | undefined;
	try {
		try {
			tempDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-"));
			const taskFile = join(tempDir, "task.md");
			const planFile = join(tempDir, "approved-plan.md");
			const ledgerFile = join(tempDir, "execution-ledger.md");
			let immutablePlanSnapshot: string | undefined;
			let planValidationError: string | undefined;
			writeFileSync(taskFile, `# User task\n\n${task}\n`, { encoding: "utf8", mode: 0o600 });
			const outcome = await runWorkflow({
				runPlanner: async () => {
					const controller = fx.beginChild("planning");
					if (!controller) return { status: "aborted", role: "planner", model: plannerModel };
					try {
						fx.setStatus(`plan-implement: planner ${plannerModel}…`);
						return await executeAgent({
							role: "planner",
							model: plannerModel,
							promptFile: join(promptsDir, "planner.md"),
							taskFile,
							cwd: initialCwd,
							signal: controller.signal,
							deps: { timeoutMs },
							onProgress: progress,
							mode,
							workLocation,
							skillPaths,
							supplementalPrompts: changePrompts,
						});
					} finally {
						fx.endChild(controller);
					}
				},
				onPlan: (plan) => {
					if (!fx.isCurrent()) return;
					const approved = `# Approved implementation plan\n\n${plan.output}\n`;
					writeFileSync(planFile, approved, { encoding: "utf8", mode: 0o600 });
					const ledger = createExecutionLedger(plan.output);
					if (!ledger.ok) planValidationError = ledger.error;
					else {
						writeFileSync(ledgerFile, ledger.ledger, { encoding: "utf8", mode: 0o600 });
						immutablePlanSnapshot = approved;
						chmodSync(planFile, 0o444);
					}
					fx.sendPhase(plan);
					fx.setStatus(undefined);
				},
				approvePlan: async () => {
					if (!fx.isCurrent()) return false;
					if (planValidationError) {
						fx.notify(`Planner output cannot be approved: ${planValidationError}`, "error");
						return false;
					}
					return fx.confirm(
						"Approve planner output?",
						mode === "stack"
							? `Review the Planner card above. Continue with ${implementerModel}, which creates local jj changes and bookmarks?`
							: `Review the Planner card above. Continue with ${implementerModel}, which creates a dedicated branch and incremental local commits?`,
					);
				},
				runImplementer: async () => {
					const controller = fx.beginChild("implementing");
					if (!controller) return { status: "aborted", role: "implementer", model: implementerModel };
					try {
						if (worktreePlan && state.workflowCwd === initialCwd) {
							fx.setStatus("plan-implement: creating managed worktree…");
							const created = await createManagedWorktree(worktreePlan, fx.exec);
							if (!created.ok)
								return { status: "failed", role: "implementer", model: implementerModel, error: created.error };
							state.workflowCwd = created.plan.path;
							if (!fx.isCurrent() || controller.signal.aborted)
								return { status: "aborted", role: "implementer", model: implementerModel };
							fx.notify(
								`Managed worktree created and retained at ${state.workflowCwd} (${created.plan.branch}).`,
								"info",
							);
						} else if (mode === "single" && !state.workstreamCheckpoint) {
							fx.setStatus("plan-implement: creating task branch…");
							const created = await createCurrentWorkstreamBranch(state.workflowCwd, task, fx.exec);
							if (!created.ok)
								return { status: "failed", role: "implementer", model: implementerModel, error: created.error };
							state.workstreamCheckpoint = { branch: created.branch, baseSha: created.baseSha };
							fx.notify(`Task branch created: ${created.branch}.`, "info");
						}
						fx.setStatus(`plan-implement: implementer ${implementerModel}…`);
						if (immutablePlanSnapshot === undefined || readFileSync(planFile, "utf8") !== immutablePlanSnapshot)
							return {
								status: "failed",
								role: "implementer",
								model: implementerModel,
								error: "Approved plan changed before implementation; the plan is read-only.",
							};
						const result = await executeAgent({
							role: "implementer",
							model: implementerModel,
							promptFile: join(promptsDir, "implementer.md"),
							taskFile,
							planFile,
							ledgerFile,
							cwd: state.workflowCwd,
							signal: controller.signal,
							deps: { timeoutMs },
							onProgress: progress,
							mode,
							workLocation,
							skillPaths,
							supplementalPrompts: changePrompts,
						});
						if (result.status !== "completed") return result;
						if (readFileSync(planFile, "utf8") !== immutablePlanSnapshot)
							return {
								status: "failed",
								role: "implementer",
								model: implementerModel,
								error: "Implementer modified the approved plan; the plan is read-only.",
							};
						const approvedPlan = readFileSync(planFile, "utf8")
							.replace(/^# Approved implementation plan\n\n/, "")
							.replace(/\n$/, "");
						const checked = validateExecutionLedger(approvedPlan, result.output);
						const ledger = checked.ok ? checked.ledger : extractExecutionLedger(result.output);
						writeFileSync(ledgerFile, ledger, { encoding: "utf8", mode: 0o600 });
						const withLedger = { ...result, executionLedger: ledger };
						if (mode !== "single" || !state.workstreamCheckpoint) return withLedger;
						const verified = await verifyCommittedWorkstream(state.workflowCwd, fx.exec, {
							...state.workstreamCheckpoint,
							requireNewCommit: true,
						});
						return verified.ok
							? withLedger
							: { status: "failed", role: "implementer", model: implementerModel, error: verified.error };
					} finally {
						fx.endChild(controller);
					}
				},
				onImplementation: (result) => {
					if (fx.isCurrent()) {
						fx.sendPhase(result);
						fx.setStatus(undefined);
					}
				},
			});
			if (fx.isCurrent()) {
				if (outcome.status === "planner-failed")
					fx.notify(
						`Planner did not complete: ${phaseErrorText(outcome.planner)}`,
						outcome.planner.status === "aborted" ? "info" : "error",
					);
				else if (outcome.status === "rejected") fx.notify("Plan rejected; the implementer was not launched.", "info");
				else if (outcome.status === "implementer-failed")
					fx.notify(
						`Implementer did not complete: ${phaseErrorText(outcome.implementer)} Committed checkpoints may exist on the task branch, and uncommitted partial edits may remain; panel review was not started.`,
						outcome.implementer.status === "aborted" ? "warning" : "error",
					);
				else
					reviewOptions =
						mode === "stack" && trunkSha
							? buildStackPanelReviewOptions(
									task,
									trunkSha,
									outcome.planner.output,
									outcome.implementer.executionLedger,
								)
							: {
									...buildPanelReviewOptions(task, outcome.planner.output, outcome.implementer.executionLedger),
									...(worktreePlan ? { base: worktreePlan.baseSha, repositoryPath: state.workflowCwd } : {}),
								};
			}
		} finally {
			if (fx.isSessionCurrent()) fx.setStatus(undefined);
			removePrivateDir(tempDir, "plan/implement", fx);
		}

		if (reviewOptions && fx.isCurrent()) {
			fx.notify(
				mode === "stack"
					? "Local stack implemented; starting panel review against trunk() base."
					: worktreePlan
						? `Implementation complete in ${state.workflowCwd}; starting panel review against the pinned base.`
						: "Implementation complete; starting panel review.",
				"info",
			);
			try {
				const request = await fx.requestPanelReview(reviewOptions);
				if (!request.handled && fx.isCurrent())
					fx.notify("panel-review did not accept the in-process review request.", "error");
				else if (request.handled && request.outcome.status === "completed" && fx.isCurrent())
					await runPostReviewPhases(request.outcome.verdict, options, state, fx);
				else if (request.handled && fx.isCurrent())
					fx.notify(
						`Panel review ended without a verdict (${request.outcome.status}); skipping the fix and publish phases.`,
						request.outcome.status === "failed" ? "warning" : "info",
					);
			} catch (error) {
				if (fx.isCurrent()) fx.notify(`panel-review request failed: ${(error as Error).message}`, "error");
			}
		}
	} finally {
		if (fx.isSessionCurrent()) fx.setStatus(undefined);
	}
}
