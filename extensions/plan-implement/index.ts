/** Two-model plan → approve → implement → panel-review orchestration. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { CHANGE_KINDS, changeKindLabel, changeKindPlaybookFile, isChangeKind, type ChangeKind } from "./change-kind.ts";
import { requestPanelReview } from "../panel-review/api.ts";
import { runAgent } from "./agent-runner.ts";
import { buildPanelReviewOptions, buildStackPanelReviewOptions, parsePlanImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveRoles } from "./config.ts";
import { preflightStack, type ExecFn } from "./delivery-mode.ts";
import { WorkflowLifecycle } from "./lifecycle.ts";
import { isChildModelAvailable } from "./model-availability.ts";
import { buildStackSkillPolicy, missingPublishSkills } from "./skill-policy.ts";
import type { PanelArgs } from "../panel-review/types.ts";
import type { AgentRole, AgentRunResult, DeliveryMode, SkillRef, WorkLocation } from "./types.ts";
import { createManagedWorktree, planManagedWorktree, type ManagedWorktreePlan } from "./worktree.ts";
import { runWorkflow } from "./workflow.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "playbooks");

interface PhaseDetails {
	schemaVersion: 1;
	phase: AgentRole;
	status: AgentRunResult["status"];
	model: string;
}

const PHASE_LABELS: Record<AgentRole, string> = {
	planner: "Planner",
	implementer: "Implementer",
	fixer: "Review fixer",
	publisher: "Publisher",
};

function errorText(result: AgentRunResult): string {
	if (result.status === "failed") return result.error;
	if (result.status === "aborted") return `${result.role} was aborted.`;
	return result.output;
}

function sendPhaseMessage(pi: ExtensionAPI, result: AgentRunResult): void {
	const details: PhaseDetails = {
		schemaVersion: 1,
		phase: result.role,
		status: result.status,
		model: result.model,
	};
	pi.sendMessage({
		customType: "plan-implement",
		content: result.status === "completed" ? result.output : errorText(result),
		display: true,
		details,
	});
}

/** Map Pi's discovered Skill objects to the SkillRef shape the policy consumes. */
function discoveredSkillRefs(ctx: { getSystemPromptOptions(): { skills?: Skill[] } }): SkillRef[] {
	const skills = ctx.getSystemPromptOptions().skills ?? [];
	return skills.map((s) => ({ name: s.name, baseDir: s.baseDir }));
}

/** Exec wrapper forwarding the preflight's per-call cwd/timeout to pi.exec. */
function makeExec(pi: ExtensionAPI): ExecFn {
	return (command, args, options) => pi.exec(command, args, { cwd: options.cwd, timeout: options.timeout });
}

export default function planImplementExtension(pi: ExtensionAPI): void {
	const lifecycle = new WorkflowLifecycle();

	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());

	pi.registerShortcut("ctrl+shift+i", {
		description: "Abort the running plan/implement agent",
		handler: async (ctx) => {
			if (lifecycle.abortActiveChild()) {
				ctx.ui.setStatus("plan-implement", "plan-implement: aborting child process…");
			} else {
				const suffix = lifecycle.currentPhase() === "approval" ? " The workflow is awaiting approval; no child is running." : "";
				ctx.ui.notify(`No plan/implement child is running.${suffix}`, "info");
			}
		},
	});

	pi.registerMessageRenderer("plan-implement", (message, { expanded, outputPad }, theme) => {
		const details = message.details as PhaseDetails | undefined;
		const phase = details ? PHASE_LABELS[details.phase] : "Implementer";
		const status = details?.status ?? "completed";
		const icon = status === "completed" ? theme.fg("success", "■") : status === "aborted" ? theme.fg("warning", "■") : theme.fg("error", "■");
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const header = `${icon} ${theme.fg("accent", phase)}${theme.fg("muted", ` — ${details?.model ?? "unknown model"} — ${status}`)}`;
		box.addChild(new Text(expanded ? `${header}\n\n${message.content}` : `${header}${theme.fg("dim", " (Ctrl+O to expand)")}`, 0, 0));
		return box;
	});

	/**
	 * Cheap preflights that must hold before a run starts: panel-review loaded
	 * and a Git working tree present. Returns an error message, or undefined
	 * when both hold. Used by runPlanImplement and (early) by the slash
	 * command so users see failures before typing a task into the editor.
	 */
	async function checkBasicPreflights(ctx: ExtensionCommandContext): Promise<string | undefined> {
		if (!pi.getCommands().some((command) => command.source === "extension" && command.name === "panel-review")) {
			return "plan-implement requires the panel-review extension to be loaded.";
		}
		const git = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5000 });
		if (git.code !== 0) {
			return "plan-implement requires a Git working tree so the completed change can be panel-reviewed.";
		}
		return undefined;
	}

	/** Core runner used by both the slash command and the in-process API. */
	async function runPlanImplement(
		rawTask: string,
		mode: DeliveryMode,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const notify = ctx.ui.notify.bind(ctx.ui);
		if (!ctx.hasUI) {
			notify("plan-implement requires interactive TUI or RPC mode.", "error");
			return;
		}
		if (lifecycle.isRunning()) {
			notify("A plan/implement run is already active.", "warning");
			return;
		}
		const commandSession = lifecycle.currentSessionToken();
		if (!commandSession) return;
		await ctx.waitForIdle();
		if (!lifecycle.isSessionCurrent(commandSession)) return;

		// Task validation applies to every entry point, including the
		// in-process event API used by the router.
		const taskResult = validateTask(rawTask);
		if (!taskResult.ok) {
			notify(taskResult.error, "warning");
			return;
		}
		const task = taskResult.task;
		if (mode === "stack" && workLocation === "worktree") {
			notify("--stack and --worktree cannot currently be combined.", "error");
			return;
		}
		nameSessionIfUnnamed(pi, task);
		const playbookFile = changeKindPlaybookFile(changeKind);
		const playbookPrompt = playbookFile ? readFileSync(join(PLAYBOOKS_DIR, playbookFile), "utf8") : undefined;

		const preflightError = await checkBasicPreflights(ctx);
		if (!lifecycle.isSessionCurrent(commandSession)) return;
		if (preflightError) {
			notify(preflightError, "error");
			return;
		}

		// The publish phase consults write-pr and find-reviewers in the child;
		// require both up front so the loop cannot silently drop its last step.
		const discoveredSkills = discoveredSkillRefs(ctx);
		const missingPublish = missingPublishSkills(discoveredSkills);
		if (missingPublish.length > 0) {
			notify(
				`plan-implement requires the ${missingPublish.map((s) => `"${s}"`).join(" and ")} skill(s) for its publish phase; ` +
					"they were not found in the session's discovered skill set.",
				"error",
			);
			return;
		}

		const configLoad = loadConfig();
		if (configLoad.status === "invalid") {
			notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
			return;
		}
		const roleResolution = resolveRoles(configLoad.status === "loaded" ? configLoad.config : null, {
			available: (provider, modelId) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
		});
		if (!roleResolution.ok) {
			notify(roleResolution.error, "error");
			return;
		}
		const roles = roleResolution.roles;
		const plannerModel = modelCliId(roles.planner);
		const implementerModel = modelCliId(roles.implementer);

		// Stack-mode prerequisites, resolved before any model call.
		let trunkSha: string | undefined;
		let skillPaths: string[] = [];
		let worktreePlan: ManagedWorktreePlan | undefined;
		if (mode === "stack") {
			const exec = makeExec(pi);
			const preflight = await preflightStack(ctx.cwd, exec, exec);
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (!preflight.ok) {
				notify(preflight.error, "error");
				return;
			}
			trunkSha = preflight.trunkSha;
			const policy = buildStackSkillPolicy(discoveredSkills);
			if (!policy.ok) {
				notify(policy.error, "error");
				return;
			}
			skillPaths = policy.skills.map((s) => s.baseDir);
		} else if (workLocation === "worktree") {
			const planned = await planManagedWorktree(ctx.cwd, task, makeExec(pi));
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (!planned.ok) {
				notify(planned.error, "error");
				return;
			}
			worktreePlan = planned.plan;
		}

		const confirmed = await ctx.ui.confirm(
			mode === "stack"
				? "Run plan → implement (stacked PRs) → panel review → fix → publish?"
				: workLocation === "worktree"
					? "Run plan → implement in managed worktree → panel review → fix → publish?"
					: "Run plan → implement → panel review → fix → publish?",
			mode === "stack"
				? `Planner (read-only): ${plannerModel}\n` +
					`Implementer (creates local jj changes + bookmarks): ${implementerModel}\n` +
					`Change kind: ${changeKindLabel(changeKind)}\n` +
					`Stack base: trunk() @ ${trunkSha?.slice(0, 8) ?? "?"}\n` +
					`Timeout: ${roles.timeoutMinutes} min per role\n\n` +
					"Stack mode disables skill discovery in children and re-adds every discovered skill except arena, " +
					"so parallel candidates cannot corrupt a shared jj operation log. The jj-stacked-prs skill is required. " +
					"The implementer builds a LOCAL stack only — it does not push or create PRs. " +
					"You will approve the plan before implementation. Successful implementation invokes panel review once against the trunk() base. " +
					"After the verdict you approve addressing its findings, then publishing the stack as draft PRs with reviewer recommendations."
				: `Planner (read-only): ${plannerModel}\n` +
					`Implementer (can modify files): ${implementerModel}\n` +
					`Change kind: ${changeKindLabel(changeKind)}\n` +
					(worktreePlan
						? `Location: ${worktreePlan.path}\nBranch: ${worktreePlan.branch}\nBase: ${worktreePlan.baseRef} @ ${worktreePlan.baseSha.slice(0, 8)}\n`
						: "Location: current working tree\n") +
					`Timeout: ${roles.timeoutMinutes} min per role\n\n` +
					"Children keep normal skill and context-file discovery enabled. Extensions are disabled in children. " +
					(worktreePlan
						? "The worktree is created only after plan approval. Implementation, review fixing, and publishing run there; the worktree is retained for explicit cleanup. "
						: "The review may include pre-existing working-tree changes. ") +
					"After the verdict you approve addressing its findings, then publishing a draft PR with reviewer recommendations.",
		);
		if (!lifecycle.isSessionCurrent(commandSession) || !confirmed) return;

		const token = lifecycle.beginWorkflow(commandSession);
		if (!token) {
			notify("The session changed or another plan/implement run started before confirmation completed.", "warning");
			return;
		}

		const timeoutMs = roles.timeoutMinutes * 60_000;
		let workflowCwd = ctx.cwd;
		const updateProgress = ({ role, turns, activity }: { role: AgentRole; turns: number; activity: string }) => {
			if (lifecycle.isCurrent(token)) {
				ctx.ui.setStatus("plan-implement", `plan-implement: ${role} · ${turns} turn(s) · ${activity}`);
			}
		};

		/**
		 * Post-review phases: address the verdict's findings with the fixer,
		 * then publish a draft PR and reviewer recommendations with the
		 * publisher. Each phase is independently confirmed; the verdict travels
		 * through a private mode-0600 temp file, never child argv.
		 */
		const runFixAndPublish = async (verdict: string): Promise<void> => {
			let reviewDir: string | undefined;
			try {
				reviewDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-review-"));
				const reviewTaskFile = join(reviewDir, "task.md");
				const verdictFile = join(reviewDir, "panel-verdict.md");
				writeFileSync(reviewTaskFile, `# User task\n\n${task}\n`, { encoding: "utf8", mode: 0o600 });
				writeFileSync(verdictFile, `# Panel-review verdict\n\n${verdict}\n`, { encoding: "utf8", mode: 0o600 });

				const fixConfirmed = await ctx.ui.confirm(
					"Address panel-review findings?",
					`Review fixer (can modify files): ${implementerModel}\n` +
						`Timeout: ${roles.timeoutMinutes} min\n\n` +
						"The fixer addresses the verdict's Act On findings (and small, clearly-correct Consider items), " +
						"verifies each against the repository, and re-runs focused tests. It does not commit or publish.",
				);
				if (lifecycle.isCurrent(token) && fixConfirmed) {
					const controller = lifecycle.beginChild(token, "fixing");
					if (controller) {
						try {
							ctx.ui.setStatus("plan-implement", `plan-implement: fixer ${implementerModel}…`);
							const fixer = await runAgent({
								role: "fixer",
								model: implementerModel,
								promptFile: join(PROMPTS_DIR, "review-fixer.md"),
								taskFile: reviewTaskFile,
								verdictFile,
								cwd: workflowCwd,
								signal: controller.signal,
								deps: { timeoutMs },
								onProgress: updateProgress,
								mode,
								workLocation,
								skillPaths,
								playbookPrompt,
							});
							if (lifecycle.isCurrent(token)) {
								sendPhaseMessage(pi, fixer);
								if (fixer.status !== "completed") {
									notify(`Review fixer did not complete: ${errorText(fixer)}`, fixer.status === "aborted" ? "info" : "error");
								}
							}
						} finally {
							lifecycle.endChild(token, controller);
							if (lifecycle.isCurrent(token)) ctx.ui.setStatus("plan-implement", undefined);
						}
					}
				}

				if (!lifecycle.isCurrent(token)) return;
				const publishConfirmed = await ctx.ui.confirm(
					mode === "stack" ? "Publish the stack as draft PRs and find reviewers?" : "Create a draft PR and find reviewers?",
					`Publisher: ${implementerModel}\n` +
						`Timeout: ${roles.timeoutMinutes} min\n\n` +
						(mode === "stack"
							? "The publisher consults jj-stacked-prs to submit the local stack as draft PRs (publish_stack.py) and write-pr " +
								"for each slice's title/body, then find-reviewers for 2–5 reviewer recommendations over the full stack. "
							: "The publisher consults write-pr to push the branch and create a DRAFT PR (or update an existing PR's " +
								"title/body), then find-reviewers for 2–5 reviewer recommendations. ") +
						"It never marks PRs ready, merges, or force-pushes; creating a PR grants the necessary push. " +
						"Reviewer recommendations are printed to the session as the run's final output.",
				);
				if (!lifecycle.isCurrent(token) || !publishConfirmed) return;
				const controller = lifecycle.beginChild(token, "publishing");
				if (!controller) return;
				try {
					ctx.ui.setStatus("plan-implement", `plan-implement: publisher ${implementerModel}…`);
					const publisher = await runAgent({
						role: "publisher",
						model: implementerModel,
						promptFile: join(PROMPTS_DIR, "publisher.md"),
						taskFile: reviewTaskFile,
						verdictFile,
						cwd: workflowCwd,
						signal: controller.signal,
						deps: { timeoutMs },
						onProgress: updateProgress,
						mode,
						workLocation,
						skillPaths,
					});
					if (lifecycle.isCurrent(token)) {
						sendPhaseMessage(pi, publisher);
						if (publisher.status === "completed") {
							notify("Publish phase complete; the draft PR and reviewer recommendations are in the Publisher card above.", "info");
						} else {
							notify(`Publisher did not complete: ${errorText(publisher)}`, publisher.status === "aborted" ? "info" : "error");
						}
					}
				} finally {
					lifecycle.endChild(token, controller);
					if (lifecycle.isCurrent(token)) ctx.ui.setStatus("plan-implement", undefined);
				}
			} finally {
				if (reviewDir) {
					try {
						rmSync(reviewDir, { recursive: true, force: true });
					} catch {
						const message = `Could not remove private review-phase temp directory ${reviewDir}; remove it manually.`;
						if (lifecycle.isSessionCurrent(token)) notify(message, "warning");
						else console.error(`plan-implement: ${message}`);
					}
				}
			}
		};

		let tempDir: string | undefined;
		let reviewOptions: PanelArgs | undefined;
		try {
			try {
				tempDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-"));
				const taskFile = join(tempDir, "task.md");
				const planFile = join(tempDir, "approved-plan.md");
				writeFileSync(taskFile, `# User task\n\n${task}\n`, { encoding: "utf8", mode: 0o600 });

				const outcome = await runWorkflow({
					runPlanner: async () => {
						const controller = lifecycle.beginChild(token, "planning");
						if (!controller) return { status: "aborted", role: "planner", model: plannerModel };
						try {
							ctx.ui.setStatus("plan-implement", `plan-implement: planner ${plannerModel}…`);
							return await runAgent({
								role: "planner",
								model: plannerModel,
								promptFile: join(PROMPTS_DIR, "planner.md"),
								taskFile,
								cwd: ctx.cwd,
								signal: controller.signal,
								deps: { timeoutMs },
								onProgress: updateProgress,
								mode,
								workLocation,
								skillPaths,
								playbookPrompt,
							});
						} finally {
							lifecycle.endChild(token, controller);
						}
					},
					onPlan: (plan) => {
						if (!lifecycle.isCurrent(token)) return;
						writeFileSync(planFile, `# Approved implementation plan\n\n${plan.output}\n`, { encoding: "utf8", mode: 0o600 });
						sendPhaseMessage(pi, plan);
						ctx.ui.setStatus("plan-implement", undefined);
					},
					approvePlan: async () => {
						if (!lifecycle.isCurrent(token)) return false;
						return ctx.ui.confirm(
							"Approve planner output?",
							`Review the Planner card above. Continue with ${implementerModel}, which can modify the working tree?`,
						);
					},
					runImplementer: async () => {
						const controller = lifecycle.beginChild(token, "implementing");
						if (!controller) return { status: "aborted", role: "implementer", model: implementerModel };
						try {
							if (worktreePlan && workflowCwd === ctx.cwd) {
								ctx.ui.setStatus("plan-implement", "plan-implement: creating managed worktree…");
								const created = await createManagedWorktree(worktreePlan, makeExec(pi));
								if (!created.ok) {
									return { status: "failed", role: "implementer", model: implementerModel, error: created.error };
								}
								workflowCwd = created.plan.path;
								if (!lifecycle.isCurrent(token) || controller.signal.aborted) {
									return { status: "aborted", role: "implementer", model: implementerModel };
								}
								notify(`Managed worktree created and retained at ${workflowCwd} (${created.plan.branch}).`, "info");
							}
							ctx.ui.setStatus("plan-implement", `plan-implement: implementer ${implementerModel}…`);
							return await runAgent({
								role: "implementer",
								model: implementerModel,
								promptFile: join(PROMPTS_DIR, "implementer.md"),
								taskFile,
								planFile,
								cwd: workflowCwd,
								signal: controller.signal,
								deps: { timeoutMs },
								onProgress: updateProgress,
								mode,
								workLocation,
								skillPaths,
								playbookPrompt,
							});
						} finally {
							lifecycle.endChild(token, controller);
						}
					},
					onImplementation: (result) => {
						if (!lifecycle.isCurrent(token)) return;
						sendPhaseMessage(pi, result);
						ctx.ui.setStatus("plan-implement", undefined);
					},
				});

				if (lifecycle.isCurrent(token)) {
					if (outcome.status === "planner-failed") {
						notify(`Planner did not complete: ${errorText(outcome.planner)}`, outcome.planner.status === "aborted" ? "info" : "error");
					} else if (outcome.status === "rejected") {
						notify("Plan rejected; the implementer was not launched.", "info");
					} else if (outcome.status === "implementer-failed") {
						notify(
							`Implementer did not complete: ${errorText(outcome.implementer)} Partial working-tree changes may exist; panel review was not started.`,
							outcome.implementer.status === "aborted" ? "warning" : "error",
						);
					} else {
						reviewOptions = mode === "stack" && trunkSha
							? buildStackPanelReviewOptions(task, trunkSha)
							: { ...buildPanelReviewOptions(task), ...(worktreePlan ? { base: worktreePlan.baseSha, repositoryPath: workflowCwd } : {}) };
					}
				}
			} finally {
				if (lifecycle.isSessionCurrent(token)) ctx.ui.setStatus("plan-implement", undefined);
				if (tempDir) {
					try {
						rmSync(tempDir, { recursive: true, force: true });
					} catch {
						const message = `Could not remove private plan/implement temp directory ${tempDir}; remove it manually.`;
						if (lifecycle.isSessionCurrent(token)) notify(message, "warning");
						else console.error(`plan-implement: ${message}`);
					}
				}
			}

			if (reviewOptions && lifecycle.isCurrent(token)) {
				notify(
					mode === "stack"
						? "Local stack implemented; starting panel review against trunk() base."
						: worktreePlan
							? `Implementation complete in ${workflowCwd}; starting panel review against the pinned base.`
							: "Implementation complete; starting panel review.",
					"info",
				);
				try {
					const request = await requestPanelReview(pi, reviewOptions, ctx);
					if (!request.handled) {
						if (lifecycle.isCurrent(token)) {
							notify("panel-review did not accept the in-process review request.", "error");
						}
					} else if (request.outcome.status === "completed") {
						if (lifecycle.isCurrent(token)) await runFixAndPublish(request.outcome.verdict);
					} else if (lifecycle.isCurrent(token)) {
						notify(
							`Panel review ended without a verdict (${request.outcome.status}); skipping the fix and publish phases.`,
							request.outcome.status === "failed" ? "warning" : "info",
						);
					}
				} catch (error) {
					if (lifecycle.isCurrent(token)) {
						notify(`panel-review request failed: ${(error as Error).message}`, "error");
					}
				}
			}
		} finally {
			if (lifecycle.isSessionCurrent(token)) ctx.ui.setStatus("plan-implement", undefined);
			lifecycle.finishWorkflow(token);
		}
	}

	pi.registerCommand("plan-implement", {
		description: "Plan, approve, implement here or in --worktree, panel-review, fix findings, then publish a draft PR",
		handler: async (args, ctx) => {
			const notify = ctx.ui.notify.bind(ctx.ui);
			if (!ctx.hasUI) {
				notify("plan-implement requires interactive TUI or RPC mode.", "error");
				return;
			}
			if (lifecycle.isRunning()) {
				notify("A plan/implement run is already active.", "warning");
				return;
			}
			const commandSession = lifecycle.currentSessionToken();
			if (!commandSession) return;
			await ctx.waitForIdle();
			if (!lifecycle.isSessionCurrent(commandSession)) return;

			// Delivery mode: a leading --single/--stack flag selects it; the
			// argument-less form asks before opening the task editor so stack
			// mode can exclude Arena before any child starts.
			// Run the cheap preflights before any editor interaction so users
			// see configuration failures before composing a task.
			const preflightError = await checkBasicPreflights(ctx);
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (preflightError) {
				notify(preflightError, "error");
				return;
			}

			const parsed = parsePlanImplementArgs(args ?? "");
			if (!parsed.ok) {
				notify(parsed.error, "warning");
				return;
			}
			let mode: DeliveryMode = parsed.mode;
			const workLocation: WorkLocation = parsed.workLocation;
			let changeKind = parsed.changeKind;
			let rawTask = parsed.task;
			if (!rawTask.trim() && !(args ?? "").trim()) {
				const choice = await ctx.ui.select(
					"Delivery mode",
					["single", "stack"],
					{},
				);
				if (!lifecycle.isSessionCurrent(commandSession)) return;
				if (!choice) return;
				mode = choice as DeliveryMode;
			}
			if (!changeKind) {
				const choice = await ctx.ui.select("Change kind", [...CHANGE_KINDS], {});
				if (!lifecycle.isSessionCurrent(commandSession)) return;
				if (!choice) return;
				if (!isChangeKind(choice)) {
					notify(`Invalid change kind selected: ${choice}.`, "error");
					return;
				}
				changeKind = choice;
			}
			if (!rawTask.trim()) rawTask = (await ctx.ui.editor("Plan and implement task:", "")) ?? "";
			if (!lifecycle.isSessionCurrent(commandSession)) return;

			await runPlanImplement(rawTask, mode, workLocation, changeKind, ctx);
		},
	});

	// Listen for in-process API requests from the router or other extensions.
	pi.events.on(PLAN_IMPLEMENT_REQUEST_EVENT, (data) => {
		claimPlanImplementRequest(data, runPlanImplement);
	});
}
