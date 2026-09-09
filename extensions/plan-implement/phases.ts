/** Deterministic plan/implement phase runners with UI and lifecycle effects injected. */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandResult } from "../land/types.ts";
import type { PanelArgs, PanelReviewOutcome } from "../panel-review/types.ts";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import { extractSlug } from "../shared/slug.ts";
import {
	newlyCreatedDrafts,
	publicationMetadataFollowUp,
	type StackPublicationMap,
	type StackPublishOutcome,
} from "../shared/stack/outcome.ts";
import type { IsolationPlan, VcsBackend, WorkstreamCheckpoint } from "../shared/vcs/backend.ts";
import { vcsPolicy } from "../shared/vcs/policy.ts";
import type { RoleRunner } from "./agent-runner.ts";
import { buildPanelReviewOptions, buildStackPanelReviewOptions } from "./command.ts";
import { parseCritique } from "./critique.ts";
import { createExecutionLedger, extractExecutionLedger, validateExecutionLedger } from "./execution-ledger.ts";
import { runHostedPhase } from "./hosted-phase.ts";
import type { WorkflowPhase } from "./lifecycle.ts";
import type { AgentRunResult, CritiqueResult, DeliveryMode, WorkLocation } from "./types.ts";
import { runWorkflow } from "./workflow.ts";

type Level = "info" | "warning" | "error";

export interface PhaseEffects {
	runner: RoleRunner;
	confirm(title: string, body: string): Promise<boolean>;
	notify(message: string, level: Level): void;
	setStatus(status: string | undefined): void;
	sendPhase(result: AgentRunResult): void;
	isCurrent(): boolean;
	isSessionCurrent(): boolean;
	beginRole(phase: Exclude<WorkflowPhase, "idle" | "approval">): AbortController | undefined;
	endRole(controller: AbortController): void;
	backend: VcsBackend;
	requestPanelReview(options: PanelArgs): Promise<{ handled: false } | { handled: true; outcome: PanelReviewOutcome }>;
	resolvePublishedPr(cwd: string): Promise<{ ok: true; prNumber: number } | { ok: false; error: string }>;
	requestLand(prNumber: number, cwd: string): Promise<{ handled: false } | { handled: true; outcome: LandResult }>;
	requestAutopilot(
		prNumber: number,
		cwd: string,
	): Promise<{ handled: false } | { handled: true; outcome: AutopilotResult }>;
	requestStackPublication?(cwd: string): Promise<{ handled: false } | { handled: true; outcome: StackPublishOutcome }>;
}

interface WorkflowState {
	workflowCwd: string;
	workstreamCheckpoint?: WorkstreamCheckpoint;
}

export interface ApprovedWorkflowOptions {
	task: string;
	mode: DeliveryMode;
	workLocation: WorkLocation;
	initialCwd: string;
	promptsDir: string;
	plannerModel: string;
	adversaryModel?: string;
	adversaryPromptFile?: string;
	maxRounds?: number;
	adversaryTimeoutMinutes?: number;
	planOnly?: boolean;
	implementerModel: string;
	timeoutMinutes: number;
	skillPaths: string[];
	changePrompts: string[];
	/** Appended only to stack implementer and review-fixer hosted agents. */
	mutationPrompts?: string[];
	trunkSha?: string;
	stackTrunkRef?: string;
	worktreePlan?: IsolationPlan;
}

export function phaseErrorText(result: AgentRunResult): string {
	if (result.status === "failed") return result.error;
	if (result.status === "aborted") return `${result.role} was aborted.`;
	if (result.status === "blocked") return `${result.role} is blocked in pane ${result.paneId}.`;
	return result.output;
}

function describeStackPublication(outcome: StackPublishOutcome): string {
	switch (outcome.status) {
		case "completed": {
			const summary = `Published ${outcome.publication.pullRequests.length} stacked PR(s).`;
			const followUp = publicationMetadataFollowUp(outcome);
			return followUp ? `${summary} ${followUp}` : summary;
		}
		case "declined":
			return "Stacked publication declined; the metadata publisher was not launched.";
		case "busy":
			return outcome.message;
		case "blocked":
			return `Stacked publication blocked: ${outcome.blockers.map((blocker) => blocker.message).join("; ")}`;
		case "stale":
			return "The stack publication plan changed after confirmation.";
		case "partial": {
			const summary = `Stacked publication was partial: ${outcome.failedAction.error}`;
			const followUp = publicationMetadataFollowUp(outcome);
			return followUp ? `${summary} ${followUp}` : summary;
		}
		case "cancelled":
			return "Stacked publication was cancelled; the metadata publisher was not launched.";
		case "indeterminate": {
			const summary = `Stacked publication is indeterminate: ${outcome.inFlight.error}`;
			const followUp = publicationMetadataFollowUp(outcome);
			return followUp ? `${summary} ${followUp}` : summary;
		}
		case "failed":
			return `Stacked publication failed: ${outcome.error}`;
		default: {
			const _exhaustive: never = outcome;
			return _exhaustive;
		}
	}
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
	const {
		task,
		mode,
		workLocation,
		promptsDir,
		implementerModel,
		timeoutMinutes,
		skillPaths,
		changePrompts,
		mutationPrompts,
	} = options;
	const timeoutMs = timeoutMinutes * 60_000;
	let reviewDir: string | undefined;
	try {
		reviewDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-review-"));
		const taskFile = join(reviewDir, "task.md");
		const verdictFile = join(reviewDir, "panel-verdict.md");
		writeFileSync(
			taskFile,
			`# User task\n\n${task}\n\nVCS backend: ${fx.backend.id}\nDelivery: ${mode}\n${state.workstreamCheckpoint ? `Workstream: ${state.workstreamCheckpoint.ref}\n` : ""}`,
			{ encoding: "utf8", mode: 0o600 },
		);
		writeFileSync(verdictFile, `# Panel-review verdict\n\n${verdict}\n`, { encoding: "utf8", mode: 0o600 });

		const fixConfirmed = await fx.confirm(
			"Address panel-review findings?",
			`Review fixer (commits verified fixes locally): ${implementerModel}\n` +
				`Timeout: ${timeoutMinutes} min\n\n` +
				"The fixer addresses the verdict's Act On findings (and small, clearly-correct Consider items), " +
				"verifies each against the repository, and re-runs focused tests. It commits verified fixes locally but does not push or publish.",
		);
		if (fx.isCurrent() && fixConfirmed) {
			const hosted = await runHostedPhase(fx, {
				phase: "fixing",
				status: `plan-implement: fixer ${implementerModel} · tab ${fx.runner.tabId}`,
				run: (signal) =>
					fx.runner.run({
						role: "fixer",
						model: implementerModel,
						promptFile: join(promptsDir, "review-fixer.md"),
						taskFile,
						verdictFile,
						cwd: state.workflowCwd,
						timeoutMs,
						signal,
						mode,
						workLocation,
						skillPaths,
						supplementalPrompts: [...changePrompts, ...(mutationPrompts ?? [])],
					}),
			});
			if (hosted.status === "ran" && fx.isCurrent()) {
				const fixer = hosted.value;
				fx.sendPhase(fixer);
				if (fixer.status !== "completed") {
					fx.notify(
						`Review fixer did not complete: ${phaseErrorText(fixer)}`,
						fixer.status === "aborted" ? "info" : "error",
					);
					return;
				}
				if (mode === "single" && state.workstreamCheckpoint) {
					const verified = await fx.backend.verifyRecordedWorkstream(state.workflowCwd, {
						...state.workstreamCheckpoint,
						requireNewCommit: false,
					});
					if (!verified.ok) {
						fx.notify(`Review fixer postcondition failed: ${verified.error} Publication was not offered.`, "error");
						return;
					}
				}
			}
		}

		if (!fx.isCurrent()) return;
		let trustedMapFile: string | undefined;
		if (mode === "stack") {
			if (!fx.requestStackPublication) {
				fx.notify("Stacked publication is unavailable; the stack provider extension may not be loaded.", "error");
				return;
			}
			const published = await fx.requestStackPublication(state.workflowCwd);
			if (!fx.isCurrent()) return;
			if (!published.handled) {
				fx.notify("Stacked publication is unavailable; the stack provider extension may not be loaded.", "error");
				return;
			}
			const outcome = published.outcome;
			const createdDrafts = newlyCreatedDrafts(outcome);
			if (outcome.status !== "completed") {
				fx.notify(
					describeStackPublication(outcome),
					outcome.status === "declined" || outcome.status === "cancelled" ? "info" : "warning",
				);
				if (createdDrafts.length === 0 || (outcome.status !== "partial" && outcome.status !== "indeterminate")) return;
			}
			const knownPublication = outcome.publication;
			if (!knownPublication) return;
			const publication: StackPublicationMap =
				outcome.status === "completed"
					? knownPublication
					: {
							...knownPublication,
							pullRequests: createdDrafts,
							topRef: createdDrafts.at(-1)?.ref ?? knownPublication.topRef,
						};
			trustedMapFile = join(reviewDir, "stack-prs.json");
			writeFileSync(trustedMapFile, `${JSON.stringify(publication, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			writeFileSync(taskFile, `${readFileSync(taskFile, "utf8")}\nTrusted published PR map: ${trustedMapFile}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			const metadataConfirmed = await fx.confirm(
				"Update titles/bodies for the published stack and recommend reviewers?",
				`Publisher: ${implementerModel}\nTimeout: ${timeoutMinutes} min\n\n` +
					`The stack structure is already published as draft PRs. The publisher may edit titles and bodies only for the PR numbers in ${trustedMapFile}, then recommend reviewers across the full stack. Declining leaves the published draft PRs unchanged.`,
			);
			if (!fx.isCurrent() || !metadataConfirmed) {
				if (fx.isCurrent() && !metadataConfirmed) {
					fx.notify("Metadata update declined; the published draft PRs were left unchanged.", "info");
				}
				return;
			}
		} else {
			const parentPublishes = fx.backend.parentOwnedPublication !== undefined;
			const publishConfirmed = await fx.confirm(
				"Create a draft PR and find reviewers?",
				`Publisher: ${implementerModel}\nTimeout: ${timeoutMinutes} min\n\n` +
					(parentPublishes
						? "The parent publishes the branch through the selected VCS backend, then the publisher edits only the verified draft PR's metadata and finds 2–5 reviewer recommendations. "
						: "The publisher consults write-pr to push the branch and create a DRAFT PR (or update an existing PR's title/body), then find-reviewers for 2–5 reviewer recommendations. ") +
					"After publishing, you will be offered PR-autopilot (watch CI, address threads, push fixes) and then landing. " +
					"It never marks PRs ready, merges, or force-pushes; creating a PR grants the necessary push. Reviewer recommendations are printed to the session as the run's final output.",
			);
			if (!fx.isCurrent() || !publishConfirmed) return;
			if (fx.backend.parentOwnedPublication) {
				if (!state.workstreamCheckpoint) {
					fx.notify("Parent-owned publication requires a recorded workstream checkpoint.", "error");
					return;
				}
				fx.setStatus(`plan-implement: publishing ${state.workstreamCheckpoint.ref}…`);
				const published = await fx.backend.parentOwnedPublication.publish(
					state.workflowCwd,
					state.workstreamCheckpoint.ref,
				);
				if (!fx.isCurrent()) return;
				if (!published.ok) {
					fx.notify(`Parent-owned publication failed: ${published.error}`, "error");
					return;
				}
				const resolved = await fx.resolvePublishedPr(state.workflowCwd);
				if (!resolved.ok) {
					fx.notify(`Publication completed, but the exact PR could not be resolved: ${resolved.error}`, "error");
					return;
				}
				writeFileSync(
					taskFile,
					`${readFileSync(taskFile, "utf8")}\nParent-published PR: #${resolved.prNumber}. Do not push or create a PR; edit only this PR's metadata.\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
			}
		}
		const hosted = await runHostedPhase(fx, {
			phase: "publishing",
			status: `plan-implement: publisher ${implementerModel} · tab ${fx.runner.tabId}`,
			run: (signal) =>
				fx.runner.run({
					role: "publisher",
					model: implementerModel,
					promptFile: join(promptsDir, "publisher.md"),
					taskFile,
					verdictFile,
					cwd: state.workflowCwd,
					timeoutMs,
					signal,
					mode,
					workLocation,
					skillPaths,
				}),
		});
		if (hosted.status === "unavailable") return;
		const publisher = hosted.value;
		if (fx.isCurrent()) {
			fx.sendPhase(publisher);
			fx.notify(
				publisher.status === "completed"
					? "Publish phase complete; the draft PR and reviewer recommendations are in the Publisher card above."
					: `Publisher did not complete: ${phaseErrorText(publisher)}`,
				publisher.status === "completed" || publisher.status === "aborted" ? "info" : "error",
			);
		}
		if (mode === "single" && publisher.status === "completed" && fx.isCurrent()) {
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
		adversaryModel,
		adversaryPromptFile,
		maxRounds,
		adversaryTimeoutMinutes,
		planOnly,
		implementerModel,
		timeoutMinutes,
		skillPaths,
		changePrompts,
		trunkSha,
		stackTrunkRef,
		worktreePlan,
	} = options;
	const timeoutMs = timeoutMinutes * 60_000;
	const policy = vcsPolicy(fx.backend.id);
	const state: WorkflowState = {
		workflowCwd: initialCwd,
		workstreamCheckpoint: worktreePlan ? { ref: worktreePlan.ref, baseSha: worktreePlan.baseSha } : undefined,
	};
	let tempDir: string | undefined;
	let reviewOptions: PanelArgs | undefined;
	try {
		try {
			tempDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-"));
			const taskFile = join(tempDir, "task.md");
			const debatePlanFile = join(tempDir, "debate-plan.md");
			const critiqueFile = join(tempDir, "critique.md");
			const planFile = join(tempDir, "approved-plan.md");
			const ledgerFile = join(tempDir, "execution-ledger.md");
			let immutablePlanSnapshot: string | undefined;
			let planValidationError: string | undefined;
			writeFileSync(
				taskFile,
				`# User task\n\n${task}\n\nVCS backend: ${fx.backend.id}\nDelivery: ${mode}\n${stackTrunkRef ? `Stack base: ${stackTrunkRef}\n` : ""}`,
				{
					encoding: "utf8",
					mode: 0o600,
				},
			);
			let debateApproval = adversaryModel ? `Adversary ${adversaryModel}: awaiting critique.` : "Adversary: skipped.";
			const runPlanningRole = async (
				role: "planner" | "adversary",
				model: string,
				promptFile: string,
				roleOptions: { planFile?: string; instructions?: string; supplementalPrompts?: string[] } = {},
			): Promise<AgentRunResult> => {
				const roleTimeoutMs = role === "adversary" ? (adversaryTimeoutMinutes ?? timeoutMinutes) * 60_000 : timeoutMs;
				const hosted = await runHostedPhase(fx, {
					phase: "planning",
					status: `plan-implement: ${role} ${model} · tab ${fx.runner.tabId}`,
					run: (signal) =>
						fx.runner.run({
							role,
							model,
							promptFile,
							taskFile,
							planFile: roleOptions.planFile,
							cwd: initialCwd,
							timeoutMs: roleTimeoutMs,
							signal,
							instructions: roleOptions.instructions,
							mode,
							workLocation,
							skillPaths,
							supplementalPrompts: roleOptions.supplementalPrompts,
						}),
				});
				if (hosted.status === "unavailable") return { status: "aborted", role, model };
				if (fx.isCurrent()) fx.sendPhase(hosted.value);
				return hosted.value;
			};
			const outcome = await runWorkflow({
				runPlanner: () =>
					runPlanningRole("planner", plannerModel, join(promptsDir, "planner.md"), {
						supplementalPrompts: changePrompts,
					}),
				debate:
					adversaryModel && adversaryPromptFile
						? {
								revisePlan: async (previous, critique) => {
									writeFileSync(debatePlanFile, previous, { encoding: "utf8", mode: 0o600 });
									writeFileSync(critiqueFile, critique, { encoding: "utf8", mode: 0o600 });
									return runPlanningRole("planner", plannerModel, join(promptsDir, "planner.md"), {
										instructions: `Read the previous plan at ${debatePlanFile} and the adversary critique at ${critiqueFile}. Return the complete revised plan with the same required header and sections. Add a Changes since last round section that addresses every blocking finding by ID.`,
										supplementalPrompts: changePrompts,
									});
								},
								critique: async (plan): Promise<CritiqueResult> => {
									writeFileSync(debatePlanFile, plan, { encoding: "utf8", mode: 0o600 });
									const result = await runPlanningRole("adversary", adversaryModel, adversaryPromptFile, {
										planFile: debatePlanFile,
									});
									if (result.status === "aborted") return { status: "aborted" };
									if (result.status !== "completed") return { status: "failed", error: phaseErrorText(result) };
									const parsed = parseCritique(result.output);
									return parsed.ok
										? { status: "completed", critique: parsed.critique }
										: { status: "failed", error: parsed.error };
								},
								maxRounds,
								resolveExhaustion: async (_plan, findings) => {
									const open =
										findings.map((finding) => `- [${finding.id}] ${finding.text}`).join("\n") ||
										"- No parsed blocking findings.";
									const plannerPane = fx.runner.paneId("planner") ?? "unknown";
									const adversaryPane = fx.runner.paneId("adversary") ?? "unknown";
									const verify = await fx.confirm(
										"Adversarial debate exhausted",
										`Open findings:\n${open}\n\nPlan: ${debatePlanFile}\nPlanner pane: ${plannerPane}\nAdversary pane: ${adversaryPane}\n\nEdit the plan file or steer the planner, then choose Verify. Decline to reject the plan.`,
									);
									return verify ? "verify" : "reject";
								},
								readPlan: () => readFileSync(debatePlanFile, "utf8"),
								onRound: (round, result, roundOptions) => {
									if (result.status === "completed" && result.critique.verdict === "approve") {
										debateApproval = roundOptions.countsAgainstBudget
											? `Adversary ${adversaryModel}: approved in round ${round}.`
											: `Adversary ${adversaryModel}: approved after human edit.`;
									}
								},
							}
						: undefined,
				onPlan: (plan) => {
					if (!fx.isCurrent()) return;
					const approved = `# Approved implementation plan\n\n${plan.output}\n`;
					writeFileSync(planFile, approved, { encoding: "utf8", mode: 0o600 });
					writeFileSync(debatePlanFile, plan.output, { encoding: "utf8", mode: 0o600 });
					const ledger = createExecutionLedger(plan.output);
					if (!ledger.ok) planValidationError = ledger.error;
					else {
						writeFileSync(ledgerFile, ledger.ledger, { encoding: "utf8", mode: 0o600 });
						immutablePlanSnapshot = approved;
						chmodSync(planFile, 0o444);
						// This is the selected snapshot, including any verified human edit.
						fx.sendPhase(plan);
					}
					if (planOnly && !planValidationError) {
						const plansDir = join(initialCwd, "local", "plans");
						mkdirSync(plansDir, { recursive: true });
						writeFileSync(join(plansDir, `${extractSlug(task)}.md`), `${plan.output}\n`, { mode: 0o600 });
					}
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
							? `${debateApproval}\nReview the Planner card above. Continue with ${implementerModel}, which creates a local ${fx.backend.id} stack?`
							: `${debateApproval}\nReview the Planner card above. Continue with ${implementerModel}, which ${policy.approvalSummary}?`,
					);
				},
				planOnly,
				runImplementer: async (): Promise<AgentRunResult> => {
					const hosted = await runHostedPhase(fx, {
						phase: "implementing",
						status: `plan-implement: implementer ${implementerModel} · tab ${fx.runner.tabId}`,
						run: async (signal): Promise<AgentRunResult> => {
							if (worktreePlan && state.workflowCwd === initialCwd) {
								fx.setStatus("plan-implement: creating managed worktree…");
								if (!fx.backend.isolation) {
									return {
										status: "failed",
										role: "implementer",
										model: implementerModel,
										error: "The configured VCS backend does not support managed worktrees.",
									};
								}
								const created = await fx.backend.isolation.create(worktreePlan);
								if (!created.ok)
									return {
										status: "failed",
										role: "implementer",
										model: implementerModel,
										error: created.error,
									};
								state.workflowCwd = created.plan.path;
								if (!fx.isCurrent() || signal.aborted)
									return { status: "aborted", role: "implementer", model: implementerModel };
								fx.notify(
									`Managed worktree created and retained at ${state.workflowCwd} (${created.plan.ref}).`,
									"info",
								);
							} else if (mode === "single" && !state.workstreamCheckpoint) {
								fx.setStatus(`plan-implement: creating task ${policy.refNoun}…`);
								const created = await fx.backend.createWorkstream(state.workflowCwd, task);
								if (!created.ok)
									return {
										status: "failed",
										role: "implementer",
										model: implementerModel,
										error: created.error,
									};
								state.workstreamCheckpoint = created;
								fx.notify(`Task ${policy.refNoun} created: ${created.ref}.`, "info");
							}
							if (state.workstreamCheckpoint) {
								writeFileSync(
									taskFile,
									`# User task\n\n${task}\n\nVCS backend: ${fx.backend.id}\nDelivery: ${mode}\nWorkstream: ${state.workstreamCheckpoint.ref}\n`,
									{ encoding: "utf8", mode: 0o600 },
								);
							}
							fx.setStatus(`plan-implement: implementer ${implementerModel} · tab ${fx.runner.tabId}`);
							if (immutablePlanSnapshot === undefined || readFileSync(planFile, "utf8") !== immutablePlanSnapshot)
								return {
									status: "failed",
									role: "implementer",
									model: implementerModel,
									error: "Approved plan changed before implementation; the plan is read-only.",
								};
							const result = await fx.runner.run({
								role: "implementer",
								model: implementerModel,
								promptFile: join(promptsDir, "implementer.md"),
								taskFile,
								planFile,
								ledgerFile,
								cwd: state.workflowCwd,
								timeoutMs,
								signal,
								mode,
								workLocation,
								skillPaths,
								supplementalPrompts: [...changePrompts, ...(options.mutationPrompts ?? [])],
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
							const verified = await fx.backend.verifyRecordedWorkstream(state.workflowCwd, {
								...state.workstreamCheckpoint,
								requireNewCommit: true,
							});
							return verified.ok
								? withLedger
								: { status: "failed", role: "implementer", model: implementerModel, error: verified.error };
						},
					});
					return hosted.status === "ran"
						? hosted.value
						: { status: "aborted", role: "implementer", model: implementerModel };
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
				else if (outcome.status === "debate-failed") {
					const error = outcome.critique.status === "failed" ? outcome.critique.error : "the adversary was aborted";
					fx.notify(`Adversarial debate did not complete: ${error}`, "error");
				} else if (outcome.status === "rejected") fx.notify("Plan rejected; the implementer was not launched.", "info");
				else if (outcome.status === "plan-only") {
					const savedPlan = join(initialCwd, "local", "plans", `${extractSlug(task)}.md`);
					if (planValidationError) fx.notify(`Plan-only run failed validation: ${planValidationError}`, "error");
					else fx.notify(`Plan-only run complete; plan at ${savedPlan}; no workstream created.`, "info");
				} else if (outcome.status === "implementer-failed")
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
									...(worktreePlan ? { base: worktreePlan.baseSha, repositoryPath: state.workflowCwd } : undefined),
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
				if (fx.isCurrent())
					fx.notify(
						`panel-review request failed: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (error as Error).message}`,
						"error",
					);
			}
		}
	} finally {
		if (fx.isSessionCurrent()) fx.setStatus(undefined);
	}
}
