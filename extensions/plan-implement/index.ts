/** Two-model plan → approve → implement → panel-review orchestration. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { requestJjStackCapabilities, requestStackPublication } from "../jj-stacked-prs/api.ts";
import { requestLand } from "../land/api.ts";
import { requestPanelReview } from "../panel-review/api.ts";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import { getAgentPaneHost } from "../shared/agent-pane.ts";
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
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { splitModelRef } from "../shared/model-spec.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import type { IsolationPlan, VcsBackend } from "../shared/vcs/backend.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { vcsPolicy } from "../shared/vcs/policy.ts";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { getArgumentCompletions, parsePlanImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveImplementerOnly, resolveRoles } from "./config.ts";
import { buildFastImplementerGuidance, type FastImplementOutcome, runFastWorktree } from "./fast-runner.ts";
import {
	buildFastKickoff,
	checkFastSettlement,
	createFastWorkstream,
	FAST_IMPLEMENT_RUN_COMPLETE_ENTRY,
	FAST_IMPLEMENT_RUN_ENTRY,
	type FastPendingRun,
	FastTakeoverController,
	preflightFastWorkstream,
} from "./fast-takeover.ts";
import { WorkflowLifecycle } from "./lifecycle.ts";
import type { PlanPipelineDashboard } from "./live-dashboard.ts";
import { runApprovedWorkflow } from "./phases.ts";
import { buildStackSkillPolicy, missingPublishSkills } from "./skill-policy.ts";
import { createStackDeliveryAdapter } from "./stack-delivery.ts";
import {
	type AgentRole,
	type AgentRunResult,
	type DeliveryMode,
	LIMITS,
	type RoleSpec,
	type SkillRef,
	type WorkLocation,
} from "./types.ts";
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
const PHASE_LABELS = {
	planner: "Planner",
	implementer: "Implementer",
	fixer: "Review fixer",
	publisher: "Publisher",
} satisfies Record<AgentRole, string>;

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
	const fastSettlement = new FastTakeoverController();
	const paneHost = getAgentPaneHost(pi);
	const backendFor = (id: VcsBackend["id"]): VcsBackend => createVcsBackend(id, makeExec(pi));
	let pendingFastToken: ReturnType<WorkflowLifecycle["currentSessionToken"]>;
	// Extensions normally load before session_start; eager activation also keeps
	// commands usable when an extension is loaded into an existing session.
	lifecycle.startSession();
	pi.on("session_start", () => {
		fastSettlement.reset();
		pendingFastToken = undefined;
		lifecycle.startSession();
	});
	pi.on("session_shutdown", () => {
		pendingFastToken = undefined;
		lifecycle.shutdownSession();
	});
	pi.on("agent_settled", async (_event, ctx) => {
		const pending = fastSettlement.begin(ctx.sessionManager.getBranch());
		if (!pending) return;
		ctx.ui.setStatus("plan-implement", "plan-implement: verifying committed work…");
		try {
			const settlement = await checkFastSettlement(pending, backendFor(pending.backend));
			if (settlement.kind === "pending") {
				ctx.ui.notify(
					`Fast implementation is not committed yet: ${settlement.reason} Continue working or steer the session; verification will retry after the next settle.`,
					"warning",
				);
				return;
			}
			await restoreFastModel(pending, ctx);
			pi.appendEntry(FAST_IMPLEMENT_RUN_COMPLETE_ENTRY, { runId: pending.runId, status: "completed" });
			postFastOutcome(settlement.outcome, pending.implementerModel ?? "", ctx);
			if (pendingFastToken) lifecycle.finishWorkflow(pendingFastToken);
			pendingFastToken = undefined;
		} finally {
			ctx.ui.setStatus("plan-implement", undefined);
			fastSettlement.finish(pending.runId);
		}
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
		const details =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ message.details as
				| PhaseDetails
				| undefined;
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
		fast: boolean,
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
		if (fast) {
			await runFastPrepared(task, workLocation, changeKind, ctx, vcsConfig);
			return;
		}
		const exec = makeExec(pi);
		const backend = backendFor(vcsConfig.backend);
		const policy = vcsPolicy(backend.id);
		const stackAdapter = createStackDeliveryAdapter(vcsConfig.backend, {
			exec,
			jjPolicy: readPromptAsset(PROMPTS_DIR, "jj-stack-local.md"),
			requestJjCapabilities: () => requestJjStackCapabilities(pi),
			requestJjPublication: (cwd) => requestStackPublication(pi, { repositoryPath: cwd }, ctx),
		});
		const engineeringPrinciplesPrompt = readPromptAsset(PLAYBOOKS_DIR, "engineering-principles.md");
		const playbookFile = changeKindPlaybookFile(changeKind);
		const playbookPrompt = playbookFile ? readPromptAsset(PLAYBOOKS_DIR, playbookFile) : undefined;
		const backendPrompt = policy.childGuidance;
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
		let stackTrunkRef: string | undefined;
		let skillPaths: string[] = [];
		let mutationPrompts: string[] = [];
		let worktreePlan: IsolationPlan | undefined;
		let stackTempDir: string | undefined;
		let stackManifestPath: string | undefined;
		if (mode === "stack") {
			if (!stackAdapter) {
				notify("The configured backend does not provide stack delivery.", "error");
				return;
			}
			const preflight = await stackAdapter.preflight(ctx.cwd);
			if (!lifecycle.isSessionCurrent(commandSession)) return;
			if (!preflight.ok) {
				notify(preflight.error, "error");
				return;
			}
			trunkSha = preflight.trunkSha;
			stackTrunkRef = preflight.trunkRef;
			skillPaths = buildStackSkillPolicy(discoveredSkills).map((skill) => skill.baseDir);
			if (stackAdapter.backendId === "graphite") {
				stackTempDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-graphite-stack-"));
				stackManifestPath = join(stackTempDir, "manifest.json");
				writeFileSync(
					stackManifestPath,
					`${JSON.stringify({ schemaVersion: 1, trunkRef: preflight.trunkRef, trunkSha: preflight.trunkSha, slices: [] }, null, 2)}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
			}
			mutationPrompts = [stackAdapter.childPolicy({ ...preflight, manifestPath: stackManifestPath })];
		} else if (workLocation === "worktree") {
			if (!backend.isolation) {
				notify("--worktree requires a backend with managed-worktree support.", "error");
				return;
			}
			const planned = await backend.isolation.plan(ctx.cwd, task);
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
				? `Planner (read-only): ${plannerModel}\nImplementer (creates a local ${stackAdapter?.backendId ?? "configured"} stack): ${implementerModel}\nChange kind: ${changeKindLabel(changeKind)}\nStack base: ${stackAdapter?.backendId === "jj" ? "trunk()" : "Graphite trunk"} @ ${trunkSha?.slice(0, 8) ?? "?"}\nTimeout: ${roles.timeoutMinutes} min per role\n\nThe implementer builds a LOCAL stack only — it does not push or create PRs. The parent independently validates the complete stack, shows the exact publication plan, confirms it, and verifies every resulting draft PR before launching the metadata/reviewer child.`
				: `Planner (read-only): ${plannerModel}\nImplementer (${policy.taskWorkstreamSummary}): ${implementerModel}\nVCS backend: ${backend.id}\nChange kind: ${changeKindLabel(changeKind)}\n${worktreePlan ? `Location: ${worktreePlan.path}\nBranch: ${worktreePlan.ref}\nBase: ${worktreePlan.baseRef} @ ${worktreePlan.baseSha.slice(0, 8)}\n` : `Location: ${policy.currentWorkspaceLabel}\n`}Timeout: ${roles.timeoutMinutes} min per role\n\nChildren keep normal skill and context-file discovery enabled. Extensions are disabled in children. ${worktreePlan ? "The worktree is created only after plan approval. Implementation, review fixing, and publishing run there on the parent-created branch; the worktree is retained for explicit cleanup. " : policy.currentModeDisclosure}After the verdict you approve addressing its findings, then publishing a draft PR with reviewer recommendations.`,
		);
		if (!lifecycle.isSessionCurrent(commandSession) || !confirmed) {
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
			return;
		}
		const token = lifecycle.beginWorkflow(commandSession);
		if (!token) {
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
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
					stackTrunkRef,
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
					requestStackPublication: async (cwd) =>
						stackAdapter
							? {
									handled: true,
									outcome: await stackAdapter.publish(cwd, stackManifestPath, ctx.ui.confirm.bind(ctx.ui)),
								}
							: { handled: false },
					dashboard,
				},
			);
		} finally {
			dashboard?.dispose();
			lifecycle.finishWorkflow(token);
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
		}
	}

	function postFastOutcome(outcome: FastImplementOutcome, implementerModel: string, ctx: ExtensionContext): void {
		const retained =
			outcome.status !== "completed" && (outcome.branch || outcome.cwd)
				? `\nRetained workstream: ${outcome.cwd ?? ctx.cwd}${outcome.branch ? ` (${outcome.branch})` : ""}${outcome.output ? `\n\n${outcome.output}` : ""}`
				: "";
		pi.sendMessage({
			customType: "plan-implement",
			content: outcome.status === "completed" ? outcome.output : `${outcome.error}${retained}`,
			display: true,
			details: { schemaVersion: 1, phase: "implementer", status: outcome.status, model: implementerModel },
		});
		ctx.ui.notify(
			outcome.status === "completed"
				? `Fast implementation completed on ${outcome.branch}.`
				: `Fast implementation ${outcome.status}; ${retained ? "inspect the retained workstream." : "no workstream was created."}`,
			outcome.status === "completed" ? "info" : "error",
		);
	}

	async function restoreFastModel(run: FastPendingRun, ctx: ExtensionContext): Promise<void> {
		if (!run.previousModel || !run.implementerModel || ctx.model === undefined) return;
		if (`${ctx.model.provider}/${ctx.model.id}` !== run.implementerModel) {
			ctx.ui.notify(
				"Fast implementation left your model selection unchanged because it changed during the run.",
				"info",
			);
			return;
		}
		const { provider, modelId } = splitModelRef(run.previousModel);
		const previous = ctx.modelRegistry.find(provider, modelId);
		if (!previous) return;
		try {
			if (await pi.setModel(previous)) {
				if (run.previousThinking) pi.setThinkingLevel(run.previousThinking);
			}
		} catch {
			// Restoration is best effort after verified work.
		}
	}

	async function startFastTakeover(
		task: string,
		implementer: RoleSpec,
		backend: VcsBackend,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
	): Promise<boolean> {
		const created = await createFastWorkstream(backend, ctx.cwd, task);
		if (!created.ok) {
			postFastOutcome({ status: "failed", error: created.error }, modelCliId(implementer), ctx);
			return false;
		}
		const cwd = ctx.cwd;
		const pending: FastPendingRun = {
			schemaVersion: 1,
			runId: crypto.randomUUID(),
			task,
			changeKind,
			backend: backend.id,
			cwd,
			checkpoint: created,
			implementerModel: implementer.model,
			...(ctx.model ? { previousModel: `${ctx.model.provider}/${ctx.model.id}` } : undefined),
			...(ctx.thinkingLevel ? { previousThinking: ctx.thinkingLevel } : undefined),
		};
		let kickoff: string;
		try {
			kickoff = buildFastKickoff(pending, buildFastImplementerGuidance(changeKind, backend));
		} catch (error) {
			postFastOutcome(
				{ status: "failed", error: error instanceof Error ? error.message : String(error), branch: created.ref, cwd },
				modelCliId(implementer),
				ctx,
			);
			return false;
		}
		const { provider, modelId } = splitModelRef(implementer.model);
		const targetModel = ctx.modelRegistry.find(provider, modelId);
		if (!targetModel) {
			postFastOutcome(
				{
					status: "failed",
					error: `Implementer ${implementer.model} is no longer available.`,
					branch: created.ref,
					cwd,
				},
				modelCliId(implementer),
				ctx,
			);
			return false;
		}
		try {
			if (!(await pi.setModel(targetModel))) {
				postFastOutcome(
					{
						status: "failed",
						error: `No credentials are available for ${implementer.model}.`,
						branch: created.ref,
						cwd,
					},
					modelCliId(implementer),
					ctx,
				);
				return false;
			}
			if (implementer.thinking) pi.setThinkingLevel(implementer.thinking);
			pi.appendEntry(FAST_IMPLEMENT_RUN_ENTRY, pending);
		} catch (error) {
			await restoreFastModel(pending, ctx);
			postFastOutcome(
				{ status: "failed", error: error instanceof Error ? error.message : String(error), branch: created.ref, cwd },
				modelCliId(implementer),
				ctx,
			);
			return false;
		}
		try {
			pi.sendUserMessage(kickoff);
		} catch (error) {
			ctx.ui.notify(
				`Fast implementation kickoff may have been accepted: ${error instanceof Error ? error.message : String(error)}. The run remains pending and will be verified when the session settles.`,
				"warning",
			);
		}
		return true;
	}

	async function runFastPrepared(
		task: string,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
		vcsConfig: ReturnType<typeof loadVcsBackend>,
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
		const fastSession = lifecycle.currentSessionToken();
		if (!fastSession) {
			notify("plan-implement has no active session; try again after the session starts.", "error");
			return;
		}
		const configLoad = loadConfig();
		if (configLoad.status === "invalid") {
			notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
			return;
		}
		for (const warning of vcsConfig.warnings) notify(warning, "warning");
		const modeError = validateVcsMode(vcsConfig.backend, "single", workLocation);
		if (modeError) {
			notify(modeError, "error");
			return;
		}
		const backend = backendFor(vcsConfig.backend);
		const policy = vcsPolicy(backend.id);
		const current = workLocation === "current";
		if (current) {
			const preflight = await preflightFastWorkstream(backend, ctx.cwd);
			if (!preflight.ok) {
				postFastOutcome({ status: "failed", error: preflight.error }, "", ctx);
				return;
			}
		} else if (!backend.isolation) {
			notify("--worktree requires a backend with managed-worktree support.", "error");
			return;
		}
		const roleResolution = resolveImplementerOnly(configLoad.status === "loaded" ? configLoad.config : null, {
			available: (provider, modelId) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
		});
		if (!roleResolution.ok) {
			notify(roleResolution.error, "error");
			return;
		}
		const implementer = roleResolution.implementer;
		const implementerModel = modelCliId(implementer);
		const timeoutMinutes =
			configLoad.status === "loaded" ? configLoad.config.timeoutMinutes : LIMITS.defaultTimeoutMinutes;
		const runToken = lifecycle.beginWorkflow(fastSession);
		if (!runToken) {
			notify("A plan/implement run is already active.", "warning");
			return;
		}
		const childController = current ? undefined : lifecycle.beginChild(runToken, "implementing");
		if (!current && !childController) {
			lifecycle.finishWorkflow(runToken);
			notify("plan-implement could not start an abortable run.", "error");
			return;
		}
		try {
			const confirmed = await ctx.ui.confirm(
				current ? "Run a fast implementation in this session?" : "Run one fast implementation worktree child?",
				`Implementer: ${implementerModel}\nVCS backend: ${backend.id}\nChange kind: ${changeKindLabel(changeKind)}\nLocation: ${current ? policy.currentWorkspaceLabel : "managed Git worktree"}\nTimeout: ${current ? "none (interrupt or steer the session normally)" : `${timeoutMinutes} min`}\n\nFast mode skips planning, panel review, and publishing, but still requires inspection, verification, and locally recorded changes. It never publishes automatically.${current ? " The implementation starts in this session, so its existing plan and discussion remain in context." : ""}`,
			);
			if (!lifecycle.isCurrent(runToken) || !confirmed) return;
			ctx.ui.setStatus(
				"plan-implement",
				current ? "plan-implement: starting fast implementation in this session…" : "plan-implement: implementing…",
			);
			if (current) {
				if (await startFastTakeover(task, implementer, backend, changeKind, ctx)) pendingFastToken = runToken;
			} else {
				postFastOutcome(
					await runFastWorktree({ task, changeKind }, implementer, ctx.cwd, {
						backend,
						signal: childController?.signal,
						timeoutMinutes,
					}),
					implementerModel,
					ctx,
				);
			}
		} finally {
			if (lifecycle.isCurrent(runToken)) ctx.ui.setStatus("plan-implement", undefined);
			if (childController) lifecycle.endChild(runToken, childController);
			if (pendingFastToken !== runToken) lifecycle.finishWorkflow(runToken);
		}
	}

	async function runPlanImplement(
		rawTask: string,
		mode: DeliveryMode,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		fast: boolean,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const task = prepareTask(rawTask, ctx.ui.notify.bind(ctx.ui));
		if (task) await runPreparedPlanImplement(task, mode, workLocation, changeKind, fast, ctx);
	}
	pi.registerCommand("plan-implement", {
		description: "Plan, approve, implement here or in --worktree, panel-review, fix findings, then publish a draft PR",
		getArgumentCompletions,
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
			const fast = parsed.fast;
			let rawTask = parsed.task;
			if (!rawTask.trim() && !(args ?? "").trim()) {
				const choice = await ctx.ui.select("Delivery mode", ["single", "stack"], {});
				if (!lifecycle.isSessionCurrent(commandSession) || !choice) return;
				mode =
					/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ choice as DeliveryMode;
			}
			if (!changeKind && fast) changeKind = "generic";
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
			if (task) await runPreparedPlanImplement(task, mode, workLocation, changeKind, fast, ctx);
		},
	});
	pi.events.on(PLAN_IMPLEMENT_REQUEST_EVENT, (data) => claimPlanImplementRequest(data, runPlanImplement));

	function createDashboard(
		ctx: ExtensionCommandContext,
		plannerModel: string,
		implementerModel: string,
	): PlanPipelineDashboard | undefined {
		if (ctx.mode !== "tui") return undefined;
		const pane = paneHost.startRun({
			ctx,
			title: "Plan & implement",
			onAbort: () => {
				if (!lifecycle.abortActiveChild()) ctx.ui.notify("No plan/implement child is running.", "info");
			},
		});
		pane.addChild({ id: "planner", label: "Planner", model: plannerModel });
		pane.addChild({ id: "implementer", label: "Implementer", model: implementerModel });
		return {
			addPhase: (id, label, model) => pane.addChild({ id, label, model }),
			markRunning: (id) => pane.markRunning(id),
			progress: (id, info) => pane.progress(id, info),
			complete: (id, info) => pane.complete(id, info),
			event: (id, event) => pane.event(id, event),
			note: (id, text) => pane.note(id, text),
			dispose: () => pane.dispose(),
		};
	}
}
