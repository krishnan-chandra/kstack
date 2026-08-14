/** Two-model plan → approve → implement → panel-review orchestration. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { requestLand } from "../land/api.ts";
import { findOpenPullRequestByHead } from "../land/github.ts";
import { requestPanelReview } from "../panel-review/api.ts";
import { makeExec } from "../shared/git-exec.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { CHANGE_KINDS, type ChangeKind, changeKindLabel, changeKindPlaybookFile, isChangeKind } from "../shared/change-kind.ts";
import { parsePlanImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveRoles } from "./config.ts";
import { preflightStack } from "./delivery-mode.ts";
import { WorkflowLifecycle } from "./lifecycle.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { runApprovedWorkflow } from "./phases.ts";
import { buildStackSkillPolicy, missingPublishSkills } from "./skill-policy.ts";
import type { AgentRole, AgentRunResult, DeliveryMode, SkillRef, WorkLocation } from "./types.ts";
import { type ManagedWorktreePlan, planManagedWorktree } from "../shared/worktree.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "..", "shared", "playbooks");
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
	const details: PhaseDetails = { schemaVersion: 1, phase: result.role, status: result.status, model: result.model };
	pi.sendMessage({
		customType: "plan-implement",
		content: result.status === "completed" ? result.output : errorText(result),
		display: true,
		details,
	});
}
function discoveredSkillRefs(ctx: { getSystemPromptOptions(): { skills?: Skill[] } }): SkillRef[] {
	return (ctx.getSystemPromptOptions().skills ?? []).map((skill) => ({ name: skill.name, baseDir: skill.baseDir }));
}
export default function planImplementExtension(pi: ExtensionAPI): void {
	const lifecycle = new WorkflowLifecycle();
	// Extensions normally load before session_start; eager activation also keeps
	// commands usable when an extension is loaded into an existing session.
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());
	pi.registerShortcut("ctrl+shift+i", {
		description: "Abort the running plan/implement agent",
		handler: async (ctx) => {
			if (lifecycle.abortActiveChild()) ctx.ui.setStatus("plan-implement", "plan-implement: aborting child process…");
			else {
				const suffix =
					lifecycle.currentPhase() === "approval" ? " The workflow is awaiting approval; no child is running." : "";
				ctx.ui.notify(`No plan/implement child is running.${suffix}`, "info");
			}
		},
	});
	pi.registerMessageRenderer("plan-implement", (message, { expanded, outputPad }, theme) => {
		const details = message.details as PhaseDetails | undefined;
		const phase = details ? PHASE_LABELS[details.phase] : "Implementer";
		const status = details?.status ?? "completed";
		const icon =
			status === "completed"
				? theme.fg("success", "■")
				: status === "aborted"
					? theme.fg("warning", "■")
					: theme.fg("error", "■");
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const header = `${icon} ${theme.fg("accent", phase)}${theme.fg("muted", ` — ${details?.model ?? "unknown model"} — ${status}`)}`;
		box.addChild(
			new Text(
				expanded ? `${header}\n\n${message.content}` : `${header}${theme.fg("dim", " (Ctrl+O to expand)")}`,
				0,
				0,
			),
		);
		return box;
	});

	async function checkBasicPreflights(ctx: ExtensionCommandContext): Promise<string | undefined> {
		if (!pi.getCommands().some((command) => command.source === "extension" && command.name === "panel-review"))
			return "plan-implement requires the panel-review extension to be loaded.";
		const git = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5000 });
		return git.code === 0
			? undefined
			: "plan-implement requires a Git working tree so the completed change can be panel-reviewed.";
	}
	function prepareTask(
		rawTask: string,
		notify: (message: string, level?: "info" | "warning" | "error") => void,
	): string | undefined {
		const result = validateTask(rawTask);
		if (!result.ok) {
			notify(result.error, "warning");
			return undefined;
		}
		nameSessionIfUnnamed(pi, result.task);
		return result.task;
	}

	async function runPreparedPlanImplement(
		task: string,
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
		if (!commandSession) {
			notify("plan-implement has no active session; try again after the session starts.", "error");
			return;
		}
		await ctx.waitForIdle();
		if (!lifecycle.isSessionCurrent(commandSession)) return;
		if (mode === "stack" && workLocation === "worktree") {
			notify("--stack and --worktree cannot currently be combined.", "error");
			return;
		}
		const engineeringPrinciplesPrompt = readFileSync(join(PLAYBOOKS_DIR, "engineering-principles.md"), "utf8");
		const playbookFile = changeKindPlaybookFile(changeKind);
		const playbookPrompt = playbookFile ? readFileSync(join(PLAYBOOKS_DIR, playbookFile), "utf8") : undefined;
		const changePrompts = playbookPrompt
			? [engineeringPrinciplesPrompt, playbookPrompt]
			: [engineeringPrinciplesPrompt];
		const preflightError = await checkBasicPreflights(ctx);
		if (!lifecycle.isSessionCurrent(commandSession)) return;
		if (preflightError) {
			notify(preflightError, "error");
			return;
		}
		const discoveredSkills = discoveredSkillRefs(ctx);
		const missingPublish = missingPublishSkills(discoveredSkills);
		if (missingPublish.length > 0) {
			notify(
				`plan-implement requires the ${missingPublish.map((skill) => `"${skill}"`).join(" and ")} skill(s) for its publish phase; they were not found in the session's discovered skill set.`,
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
			skillPaths = policy.skills.map((skill) => skill.baseDir);
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
				? `Planner (read-only): ${plannerModel}\nImplementer (creates local jj changes + bookmarks): ${implementerModel}\nChange kind: ${changeKindLabel(changeKind)}\nStack base: trunk() @ ${trunkSha?.slice(0, 8) ?? "?"}\nTimeout: ${roles.timeoutMinutes} min per role\n\nStack mode disables skill discovery in children and re-adds every discovered skill except arena, so parallel candidates cannot corrupt a shared jj operation log. The jj-stacked-prs skill is required. The implementer builds a LOCAL stack only — it does not push or create PRs. You will approve the plan before implementation. Successful implementation invokes panel review once against the trunk() base. After the verdict you approve addressing its findings, then publishing the stack as draft PRs with reviewer recommendations.`
				: `Planner (read-only): ${plannerModel}\nImplementer (creates a dedicated branch and incremental local commits): ${implementerModel}\nChange kind: ${changeKindLabel(changeKind)}\n${worktreePlan ? `Location: ${worktreePlan.path}\nBranch: ${worktreePlan.branch}\nBase: ${worktreePlan.baseRef} @ ${worktreePlan.baseSha.slice(0, 8)}\n` : "Location: current working tree\n"}Timeout: ${roles.timeoutMinutes} min per role\n\nChildren keep normal skill and context-file discovery enabled. Extensions are disabled in children. ${worktreePlan ? "The worktree is created only after plan approval. Implementation, review fixing, and publishing run there on the parent-created branch; the worktree is retained for explicit cleanup. " : "Current-mode implementation requires a clean working tree, creates a dedicated kstack/<task-slug> branch, and commits verified increments. If this checkout is dirty, stop and rerun with --worktree. "}After the verdict you approve addressing its findings, then publishing a draft PR with reviewer recommendations.`,
		);
		if (!lifecycle.isSessionCurrent(commandSession) || !confirmed) return;
		const token = lifecycle.beginWorkflow(commandSession);
		if (!token) {
			notify("The session changed or another plan/implement run started before confirmation completed.", "warning");
			return;
		}
		try {
			await runApprovedWorkflow(
				{
					task,
					mode,
					workLocation,
					initialCwd: ctx.cwd,
					promptsDir: PROMPTS_DIR,
					plannerModel,
					implementerModel,
					timeoutMinutes: roles.timeoutMinutes,
					skillPaths,
					changePrompts,
					trunkSha,
					worktreePlan,
				},
				{
					confirm: ctx.ui.confirm.bind(ctx.ui),
					notify,
					setStatus: (status) => ctx.ui.setStatus("plan-implement", status),
					sendPhase: (result) => sendPhaseMessage(pi, result),
					isCurrent: () => lifecycle.isCurrent(token),
					isSessionCurrent: () => lifecycle.isSessionCurrent(token),
					beginChild: (phase) => lifecycle.beginChild(token, phase),
					endChild: (controller) => lifecycle.endChild(token, controller),
					exec: makeExec(pi),
					requestPanelReview: (options) => requestPanelReview(pi, options, ctx),
					resolvePublishedPr: async (cwd) => {
						const exec = makeExec(pi);
						const branch = await exec("git", ["branch", "--show-current"], { cwd, timeout: 15_000 });
						const head = branch.code === 0 ? branch.stdout.trim() : "";
						if (!head) return { ok: false, error: "could not resolve the workflow branch." };
						try {
							return {
								ok: true,
								prNumber: await findOpenPullRequestByHead(
									(command, args, options) => pi.exec(command, args, options),
									cwd,
									head,
								),
							};
						} catch (error) {
							return { ok: false, error: error instanceof Error ? error.message : String(error) };
						}
					},
					requestLand: (prNumber, cwd) =>
						requestLand(pi, { target: { kind: "single", prNumber }, readiness: "watch", cwd }, ctx),
				},
			);
		} finally {
			lifecycle.finishWorkflow(token);
		}
	}

	async function runPlanImplement(
		rawTask: string,
		mode: DeliveryMode,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const task = prepareTask(rawTask, ctx.ui.notify.bind(ctx.ui));
		if (task) await runPreparedPlanImplement(task, mode, workLocation, changeKind, ctx);
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
			const parsed = parsePlanImplementArgs(args ?? "");
			if (!parsed.ok) {
				notify(parsed.error, "warning");
				return;
			}
			let task = parsed.task.trim() ? prepareTask(parsed.task, notify) : undefined;
			if (parsed.task.trim() && !task) return;
			await ctx.waitForIdle();
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			const preflightError = await checkBasicPreflights(ctx);
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (preflightError) {
				notify(preflightError, "error");
				return;
			}
			let mode: DeliveryMode = parsed.mode;
			const workLocation = parsed.workLocation;
			let changeKind = parsed.changeKind;
			let rawTask = parsed.task;
			if (!rawTask.trim() && !(args ?? "").trim()) {
				const choice = await ctx.ui.select("Delivery mode", ["single", "stack"], {});
				if (!lifecycle.isSessionCurrent(commandSession) || !choice) return;
				mode = choice as DeliveryMode;
			}
			if (!changeKind) {
				const choice = await ctx.ui.select("Change kind", [...CHANGE_KINDS], {});
				if (!lifecycle.isSessionCurrent(commandSession) || !choice) return;
				if (!isChangeKind(choice)) {
					notify(`Invalid change kind selected: ${choice}.`, "error");
					return;
				}
				changeKind = choice;
			}
			if (!rawTask.trim()) rawTask = (await ctx.ui.editor("Plan and implement task:", "")) ?? "";
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			task ??= prepareTask(rawTask, notify);
			if (task) await runPreparedPlanImplement(task, mode, workLocation, changeKind, ctx);
		},
	});
	pi.events.on(PLAN_IMPLEMENT_REQUEST_EVENT, (data) => claimPlanImplementRequest(data, runPlanImplement));
}
