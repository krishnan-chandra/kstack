/** Two-model plan → approve → implement → panel-review orchestration. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { Box, stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { requestJjStackCapabilities, requestStackPublication } from "../jj-stacked-prs/api.ts";
import { requestLand } from "../land/api.ts";
import { requestPanelReview } from "../panel-review/api.ts";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import {
	CHANGE_KINDS,
	type ChangeKind,
	changeKindLabel,
	changeKindPlaybookFile,
	isChangeKind,
} from "../shared/change-kind.ts";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { makeExec } from "../shared/git-exec.ts";
import { findOpenPullRequestByHead } from "../shared/github.ts";
import { mountLiveDashboard } from "../shared/live-dashboard.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import type { IsolationPlan } from "../shared/vcs/backend.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { vcsChildGuidance } from "../shared/vcs/guidance.ts";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { parsePlanImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveRoles } from "./config.ts";
import { preflightStack } from "./delivery-mode.ts";
import { type OpenInspectorResult, openInspector } from "./inspector-overlay.ts";
import { WorkflowLifecycle } from "./lifecycle.ts";
import { PlanImplementDashboardStore, type PlanPipelineDashboard } from "./live-dashboard.ts";
import { runApprovedWorkflow } from "./phases.ts";
import { buildStackSkillPolicy, missingPublishSkills } from "./skill-policy.ts";
import { PlanImplementTranscriptStore } from "./transcript-store.ts";
import type { AgentRole, AgentRunResult, DeliveryMode, SkillRef, WorkLocation } from "./types.ts";
import { validateVcsMode } from "./vcs-mode.ts";

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
	guardCommandFallthrough(pi, "plan-implement");
	const lifecycle = new WorkflowLifecycle();
	let activeInspector: OpenInspectorResult | undefined;
	let activeStores: { dashboard: PlanImplementDashboardStore; transcripts: PlanImplementTranscriptStore } | undefined;
	// Extensions normally load before session_start; eager activation also keeps
	// commands usable when an extension is loaded into an existing session.
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => {
		activeInspector?.close();
		activeInspector = undefined;
		activeStores = undefined;
		lifecycle.shutdownSession();
	});
	pi.registerShortcut("ctrl+shift+p", {
		description: "Inspect plan/implement child transcripts",
		handler: async (ctx) => {
			if (ctx.mode !== "tui" || !activeStores || !lifecycle.isRunning()) {
				ctx.ui.notify("No plan/implement run is active.", "info");
				return;
			}
			if (activeInspector) return;
			const { dashboard, transcripts } = activeStores;
			const inspector = openInspector(ctx, dashboard, transcripts, {
				text: {
					stripTerminalSequences,
					truncateToWidth: (text, width) => truncateToWidth(text, width),
				},
				onAbort: () => {
					if (!lifecycle.abortActiveChild()) {
						const suffix =
							lifecycle.currentPhase() === "approval" ? " The workflow is awaiting approval; no child is running." : "";
						ctx.ui.notify(`No plan/implement child is running.${suffix}`, "info");
					}
				},
			});
			activeInspector = inspector;
			inspector.closed.finally(() => {
				if (activeInspector === inspector) activeInspector = undefined;
			});
		},
	});
	pi.registerShortcut("ctrl+shift+i", {
		description: "Abort the running plan/implement agent",
		handler: async (ctx) => {
			if (lifecycle.abortActiveChild()) {
				if (ctx.mode !== "tui") {
					ctx.ui.setStatus("plan-implement", "plan-implement: aborting child process…");
				}
			} else {
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

	async function checkBasicPreflights(_ctx: ExtensionCommandContext): Promise<string | undefined> {
		return pi.getCommands().some((command) => command.source === "extension" && command.name === "panel-review")
			? undefined
			: "plan-implement requires the panel-review extension to be loaded.";
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
		const vcsConfig = loadVcsBackend();
		for (const warning of vcsConfig.warnings) notify(warning, "warning");
		const modeError = validateVcsMode(vcsConfig.backend, mode, workLocation);
		if (modeError) {
			notify(modeError, "error");
			return;
		}
		const exec = makeExec(pi);
		const backend = createVcsBackend(vcsConfig.backend, exec);
		const engineeringPrinciplesPrompt = readPromptAsset(PLAYBOOKS_DIR, "engineering-principles.md");
		const playbookFile = changeKindPlaybookFile(changeKind);
		const playbookPrompt = playbookFile ? readPromptAsset(PLAYBOOKS_DIR, playbookFile) : undefined;
		const backendPrompt = vcsChildGuidance(vcsConfig.backend);
		const changePrompts = playbookPrompt
			? [engineeringPrinciplesPrompt, playbookPrompt, backendPrompt]
			: [engineeringPrinciplesPrompt, backendPrompt];
		const preflightError = await checkBasicPreflights(ctx);
		if (!lifecycle.isSessionCurrent(commandSession)) return;
		if (preflightError) {
			notify(preflightError, "error");
			return;
		}
		if (mode === "single") {
			const preflight = await backend.preflight(ctx.cwd);
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (!preflight.ok) {
				notify(preflight.error, "error");
				return;
			}
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
		let mutationPrompts: string[] = [];
		let worktreePlan: IsolationPlan | undefined;
		if (mode === "stack") {
			const capabilities = await requestJjStackCapabilities(pi);
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (!capabilities.handled) {
				notify("Stack mode requires the jj-stacked-prs extension to be loaded before any model call.", "error");
				return;
			}
			const preflight = await preflightStack(ctx.cwd, exec);
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (!preflight.ok) {
				notify(preflight.error, "error");
				return;
			}
			trunkSha = preflight.trunkSha;
			skillPaths = buildStackSkillPolicy(discoveredSkills).map((skill) => skill.baseDir);
			mutationPrompts = [readPromptAsset(PROMPTS_DIR, "jj-stack-local.md")];
		} else if (workLocation === "worktree") {
			if (backend.id !== "git") {
				notify("--worktree requires the git backend.", "error");
				return;
			}
			const planned = await backend.planIsolation(ctx.cwd, task);
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
				? `Planner (read-only): ${plannerModel}\nImplementer (creates local jj changes + bookmarks): ${implementerModel}\nChange kind: ${changeKindLabel(changeKind)}\nStack base: trunk() @ ${trunkSha?.slice(0, 8) ?? "?"}\nTimeout: ${roles.timeoutMinutes} min per role\n\nStack mode disables skill discovery in children and re-adds every discovered skill except arena, so parallel candidates cannot corrupt a shared jj operation log. The jj-stacked-prs extension is required. The implementer builds a LOCAL stack only — it does not push or create PRs. You will approve the plan before implementation. Successful implementation invokes panel review once against the trunk() base. After the verdict the loaded extension confirms structural publication, then you may approve a metadata/reviewer child.`
				: `Planner (read-only): ${plannerModel}\nImplementer (${backend.id === "jj" ? "creates a dedicated jj change and task bookmark" : "creates a dedicated branch and incremental Git commits"}): ${implementerModel}\nVCS backend: ${backend.id}\nChange kind: ${changeKindLabel(changeKind)}\n${worktreePlan ? `Location: ${worktreePlan.path}\nBranch: ${worktreePlan.ref}\nBase: ${worktreePlan.baseRef} @ ${worktreePlan.baseSha.slice(0, 8)}\n` : backend.id === "jj" ? "Location: current jj workspace\n" : "Location: current Git working tree\n"}Timeout: ${roles.timeoutMinutes} min per role\n\nChildren keep normal skill and context-file discovery enabled. Extensions are disabled in children. ${worktreePlan ? "The worktree is created only after plan approval. Implementation, review fixing, and publishing run there on the parent-created branch; the worktree is retained for explicit cleanup. " : backend.id === "jj" ? "The parent creates a trunk()-based jj change and task bookmark after plan approval. jj snapshots the current workspace state, so Git dirty-tree rules do not apply. " : "Current-mode implementation requires a clean working tree, creates a dedicated kstack/<task-slug> branch, and commits verified increments. If this checkout is dirty, stop and rerun with --worktree. "}After the verdict you approve addressing its findings, then publishing a draft PR with reviewer recommendations.`,
		);
		if (!lifecycle.isSessionCurrent(commandSession) || !confirmed) return;
		const token = lifecycle.beginWorkflow(commandSession);
		if (!token) {
			notify("The session changed or another plan/implement run started before confirmation completed.", "warning");
			return;
		}
		const dashboard = createDashboard(ctx, plannerModel, implementerModel);
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
					mutationPrompts,
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
					backend,
					requestPanelReview: (options) => requestPanelReview(pi, options, ctx),
					resolvePublishedPr: async (cwd) => {
						const current = await backend.currentRef(cwd);
						const head =
							current.ok && (current.ref.kind === "branch" || current.ref.kind === "bookmark") ? current.ref.name : "";
						if (!head) return { ok: false, error: "could not resolve the workflow branch or bookmark." };
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
					requestAutopilot: (prNumber, cwd) => requestPrAutopilot(pi, "drive", prNumber, ctx, cwd),
					requestStackPublication: (cwd) => requestStackPublication(pi, { repositoryPath: cwd }, ctx),
					dashboard,
				},
			);
		} finally {
			dashboard?.dispose();
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

	function createDashboard(
		ctx: ExtensionCommandContext,
		plannerModel: string,
		implementerModel: string,
	): PlanPipelineDashboard | undefined {
		if (ctx.mode !== "tui") return undefined;
		const dashboardStore = new PlanImplementDashboardStore();
		const transcriptStore = new PlanImplementTranscriptStore();
		dashboardStore.addPhase("planner", "Planner", plannerModel, "planner");
		transcriptStore.addChild("planner");
		dashboardStore.addPhase("implementer", "Implementer", implementerModel, "implementer");
		transcriptStore.addChild("implementer");

		activeStores = { dashboard: dashboardStore, transcripts: transcriptStore };
		const disposeWidget = mountLiveDashboard(ctx.ui, "plan-implement", dashboardStore, {
			stripTerminalSequences,
			truncateToWidth: (text, width) => truncateToWidth(text, width),
		});
		const ticker = setInterval(() => {
			dashboardStore.tick();
		}, 1000);
		ticker.unref?.();

		return {
			addPhase: (id, label, model, role) => {
				dashboardStore.addPhase(id, label, model, role);
				transcriptStore.addChild(id);
			},
			markRunning: (id) => dashboardStore.markRunning(id),
			progress: (id, info) => dashboardStore.progress(id, info),
			complete: (id, info) => dashboardStore.complete(id, info),
			event: (id, ev) => transcriptStore.push(id, ev),
			note: (id, text) => transcriptStore.note(id, text),
			tick: () => dashboardStore.tick(),
			dispose: () => {
				clearInterval(ticker);
				activeInspector?.close();
				activeInspector = undefined;
				activeStores = undefined;
				transcriptStore.dispose();
				disposeWidget();
			},
		};
	}
}
