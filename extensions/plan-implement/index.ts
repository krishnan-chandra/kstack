/** Hosted planner → adversary debate → implementation → panel-review orchestration. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
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
import { openAgentHost, preflightHerdr } from "../shared/herdr/agent-host.ts";
import { createNodeHerdrExec } from "../shared/herdr/herdr-cli.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import { extractSlug } from "../shared/slug.ts";
import type { IsolationPlan, VcsBackend } from "../shared/vcs/backend.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { vcsPolicy } from "../shared/vcs/policy.ts";
import { createRoleRunner } from "./agent-runner.ts";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { getArgumentCompletions, parsePlanImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveAdversary, resolveImplementerOnly, resolveRoles } from "./config.ts";
import { type FastImplementOutcome, runFastCurrent, runFastWorktree } from "./fast-runner.ts";
import { WorkflowLifecycle } from "./lifecycle.ts";
import { runApprovedWorkflow } from "./phases.ts";
import { buildStackSkillPolicy, missingPublishSkills } from "./skill-policy.ts";
import { createStackDeliveryClient } from "./stack-delivery.ts";
import {
	type AgentRole,
	type AgentRunResult,
	type DeliveryMode,
	LIMITS,
	type SkillRef,
	type WorkLocation,
} from "./types.ts";
import { validateVcsMode } from "./vcs-mode.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "..", "shared", "playbooks");
const ADVERSARY_PROMPT_FILE = join(EXTENSION_DIR, "..", "..", "skills", "adversarial-planning", "adversary-prompt.md");
interface PhaseDetails {
	schemaVersion: 2;
	phase: AgentRole;
	status: AgentRunResult["status"];
	model: string;
	turns?: number;
	cost?: number;
}
const PHASE_LABELS = {
	planner: "Planner",
	adversary: "Adversary",
	implementer: "Implementer",
	fixer: "Review fixer",
	publisher: "Publisher",
} satisfies Record<AgentRole, string>;

function errorText(result: AgentRunResult): string {
	if (result.status === "failed") return result.error;
	if (result.status === "aborted") return `${result.role} was aborted.`;
	if (result.status === "blocked") return `${result.role} is blocked in pane ${result.paneId}.`;
	return result.output;
}
function sendPhaseMessage(pi: ExtensionAPI, result: AgentRunResult): void {
	const details: PhaseDetails = { schemaVersion: 2, phase: result.role, status: result.status, model: result.model };
	if (result.status === "completed") {
		details.turns = result.usage.turns;
		details.cost = result.usage.cost;
	}
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
	const backendFor = (id: VcsBackend["id"]): VcsBackend => createVcsBackend(id, makeExec(pi));
	// Extensions normally load before session_start; eager activation also keeps
	// commands usable when an extension is loaded into an existing session.
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());
	pi.registerShortcut("ctrl+shift+i", {
		description: "Abort the running plan/implement hosted agent",
		handler: async (ctx) => {
			if (lifecycle.abortActiveRole()) {
				ctx.ui.setStatus("plan-implement", "plan-implement: aborting hosted agent…");
			} else {
				const suffix =
					lifecycle.currentPhase() === "approval"
						? " The workflow is awaiting approval; no hosted agent is running."
						: "";
				ctx.ui.notify(`No plan/implement hosted agent is running.${suffix}`, "info");
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
		const usage = details?.turns === undefined ? "" : ` — ${details.turns} turn(s), $${(details.cost ?? 0).toFixed(4)}`;
		const header = `${icon} ${theme.fg("accent", phase)}${theme.fg("muted", ` — ${details?.model ?? "unknown model"} — ${status}${usage}`)}`;
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
		adversary: boolean,
		planOnly: boolean,
		ctx: ExtensionCommandContext,
		planFile?: string,
	): Promise<void> {
		const notify = ctx.ui.notify.bind(ctx.ui);
		if (ctx.mode !== "tui") {
			notify("plan-implement requires interactive TUI mode inside Herdr.", "error");
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
		const herdrExec = createNodeHerdrExec();
		const herdr = await preflightHerdr({ exec: herdrExec });
		if (!herdr.ok) {
			notify(herdr.error, "error");
			return;
		}
		const vcsConfig = loadVcsBackend();
		for (const warning of vcsConfig.warnings) notify(warning, "warning");
		const modeError = validateVcsMode(vcsConfig.backend, mode, workLocation);
		if (modeError) {
			notify(modeError, "error");
			return;
		}
		if (fast) {
			await runFastPrepared(task, workLocation, changeKind, ctx, vcsConfig, planFile);
			return;
		}
		const backend = backendFor(vcsConfig.backend);
		const policy = vcsPolicy(backend.id);
		const stackClient = createStackDeliveryClient(pi, vcsConfig, ctx);
		const engineeringPrinciplesPrompt = readPromptAsset(PLAYBOOKS_DIR, "engineering-principles.md");
		const playbookFile = changeKindPlaybookFile(changeKind);
		const playbookPrompt = playbookFile ? readPromptAsset(PLAYBOOKS_DIR, playbookFile) : undefined;
		const backendPrompt = policy.childGuidance;
		const changePrompts = playbookPrompt
			? [engineeringPrinciplesPrompt, playbookPrompt, backendPrompt]
			: [engineeringPrinciplesPrompt, backendPrompt];
		const preflightError = planOnly ? undefined : await checkBasicPreflights(ctx);
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
		const missingPublish = planOnly ? [] : missingPublishSkills(discoveredSkills);
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
		const adversaryResolution = resolveAdversary(adversary, roles.planner.model, {
			available: (provider, modelId) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
		});
		if (!adversaryResolution.ok) {
			notify(adversaryResolution.error, "error");
			return;
		}
		if (adversaryResolution.notice) notify(adversaryResolution.notice, "info");
		const adversaryModel = adversaryResolution.adversary?.model;
		const adversaryTimeoutMinutes = adversaryResolution.adversary?.timeoutMinutes;
		const maxRounds = adversaryResolution.adversary?.maxRounds;
		let trunkSha: string | undefined;
		let stackTrunkRef: string | undefined;
		let skillPaths: string[] = [];
		let mutationPrompts: string[] = [];
		let worktreePlan: IsolationPlan | undefined;
		let stackTempDir: string | undefined;
		let stackManifestPath: string | undefined;
		if (mode === "stack") {
			if (!stackClient) {
				notify("The configured backend does not provide stack delivery.", "error");
				return;
			}
			if (stackClient.provider !== "jj" && !planOnly) {
				stackTempDir = mkdtempSync(join(tmpdir(), "pi-plan-implement-stack-"));
				stackManifestPath = join(stackTempDir, "manifest.json");
			}
			const preflight = await stackClient.preflight(ctx.cwd, stackManifestPath, planOnly);
			if (!lifecycle.isSessionCurrent(commandSession)) {
				if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
				return;
			}
			if (!preflight.ok) {
				if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
				notify(preflight.error, "error");
				return;
			}
			trunkSha = preflight.trunkSha;
			stackTrunkRef = preflight.trunkRef;
			skillPaths = buildStackSkillPolicy(discoveredSkills).map((skill) => skill.baseDir);
			if (stackClient.provider !== "jj" && stackManifestPath) {
				writeFileSync(
					stackManifestPath,
					`${JSON.stringify({ schemaVersion: 1, trunkRef: preflight.trunkRef, trunkSha: preflight.trunkSha, slices: [] }, null, 2)}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
			}
			mutationPrompts = [preflight.childPolicy];
		} else if (workLocation === "worktree" && !planOnly) {
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
		let stackBaseLabel = "";
		if (stackClient?.provider === "jj") stackBaseLabel = "trunk()";
		else if (stackClient?.provider === "graphite") stackBaseLabel = "Graphite trunk";
		else if (stackClient?.provider === "github") stackBaseLabel = "Git remote trunk";
		let maxAgents = planOnly ? 1 : 4;
		if (adversaryModel) maxAgents++;
		const opened = await openAgentHost(
			{ owner: "plan-implement", label: extractSlug(task), cwd: ctx.cwd, maxAgents },
			{ exec: herdrExec },
		);
		if (!opened.ok) {
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
			notify(opened.error, "error");
			return;
		}
		const host = opened.host;
		let confirmationTitle = "Run plan → implement → panel review → fix → publish?";
		if (planOnly) confirmationTitle = "Run planner and stop after the final plan?";
		else if (mode === "stack") confirmationTitle = "Run plan → implement (stacked PRs) → panel review → fix → publish?";
		else if (workLocation === "worktree") {
			confirmationTitle = "Run plan → implement in managed worktree → panel review → fix → publish?";
		}
		const confirmed = await ctx.ui.confirm(
			confirmationTitle,
			mode === "stack"
				? `Planner (read-only): ${plannerModel}\nAdversary: ${adversaryModel ?? "none"}\nImplementer (creates a local ${stackClient?.provider ?? "configured"} stack): ${planOnly ? "not run" : implementerModel}\nHerdr tab: ${host.tabId}\nChange kind: ${changeKindLabel(changeKind)}\nStack base: ${stackBaseLabel} @ ${trunkSha?.slice(0, 8) ?? "?"}\nTimeout: ${roles.timeoutMinutes} min per role`
				: `Planner (read-only): ${plannerModel}\nAdversary: ${adversaryModel ?? "none"}\nImplementer (${policy.taskWorkstreamSummary}): ${planOnly ? "not run" : implementerModel}\nHerdr tab: ${host.tabId}\nVCS backend: ${backend.id}\nChange kind: ${changeKindLabel(changeKind)}\n${worktreePlan ? `Location: ${worktreePlan.path}\nBranch: ${worktreePlan.ref}\nBase: ${worktreePlan.baseRef} @ ${worktreePlan.baseSha.slice(0, 8)}\n` : `Location: ${policy.currentWorkspaceLabel}\n`}Timeout: ${roles.timeoutMinutes} min per role`,
		);
		if (!lifecycle.isSessionCurrent(commandSession) || !confirmed) {
			await host.dispose({ closeTab: true });
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
			return;
		}
		const token = lifecycle.beginWorkflow(commandSession);
		if (!token) {
			await host.dispose({ closeTab: true });
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
			notify("The session changed or another plan/implement run started before confirmation completed.", "warning");
			return;
		}
		const runner = createRoleRunner(host, {
			onStarted: (role, model, paneId) => {
				if (lifecycle.isCurrent(token)) {
					ctx.ui.setStatus("plan-implement", `plan-implement: ${role} ${model} · pane ${paneId}`);
				}
			},
			onBlocked: async (role, paneId, signal) =>
				ctx.ui.confirm(
					`${PHASE_LABELS[role]} is waiting for input`,
					`Answer the agent in pane ${paneId}, then continue. Decline to abort this phase.`,
					{ signal },
				),
		});
		try {
			await runApprovedWorkflow(
				{
					task,
					mode,
					workLocation,
					initialCwd: ctx.cwd,
					promptsDir: PROMPTS_DIR,
					plannerModel,
					adversaryModel,
					adversaryPromptFile: adversaryModel ? ADVERSARY_PROMPT_FILE : undefined,
					maxRounds,
					adversaryTimeoutMinutes,
					planOnly,
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
					runner,
					confirm: ctx.ui.confirm.bind(ctx.ui),
					notify,
					setStatus: (status) => ctx.ui.setStatus("plan-implement", status),
					sendPhase: (result) => sendPhaseMessage(pi, result),
					isCurrent: () => lifecycle.isCurrent(token),
					isSessionCurrent: () => lifecycle.isSessionCurrent(token),
					beginRole: (phase) => lifecycle.beginRole(token, phase),
					endRole: (controller) => lifecycle.endRole(token, controller),
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
						stackClient
							? {
									handled: true,
									outcome: await stackClient.publish(cwd, stackManifestPath, ctx.signal),
								}
							: { handled: false },
				},
			);
		} finally {
			await runner.dispose();
			if (lifecycle.isSessionCurrent(token)) {
				notify(`Hosted agents retained in Herdr tab ${runner.tabId}.`, "info");
			}
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
			details: { schemaVersion: 2, phase: "implementer", status: outcome.status, model: implementerModel },
		});
		ctx.ui.notify(
			outcome.status === "completed"
				? `Fast implementation completed on ${outcome.branch}.`
				: `Fast implementation ${outcome.status}; ${retained ? "inspect the retained workstream." : "no workstream was created."}`,
			outcome.status === "completed" ? "info" : "error",
		);
	}

	async function runFastPrepared(
		task: string,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
		vcsConfig: ReturnType<typeof loadVcsBackend>,
		planFile?: string,
	): Promise<void> {
		const notify = ctx.ui.notify.bind(ctx.ui);
		if (ctx.mode !== "tui") {
			notify("plan-implement requires interactive TUI mode inside Herdr.", "error");
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
		if (workLocation === "worktree" && !backend.isolation) {
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
		const confirmed = await ctx.ui.confirm(
			"Run one fast hosted implementer?",
			`Implementer: ${implementerModel}\nVCS backend: ${backend.id}\nChange kind: ${changeKindLabel(changeKind)}\nLocation: ${workLocation === "current" ? policy.currentWorkspaceLabel : "managed Git worktree"}\nTimeout: ${timeoutMinutes} min\n\nFast mode skips planning, panel review, and publishing. It runs in a visible Herdr pane, verifies locally recorded changes, and never publishes automatically.`,
		);
		if (!lifecycle.isSessionCurrent(fastSession) || !confirmed) return;
		const runToken = lifecycle.beginWorkflow(fastSession);
		if (!runToken) {
			notify("A plan/implement run is already active.", "warning");
			return;
		}
		const controller = lifecycle.beginRole(runToken, "implementing");
		if (!controller) {
			lifecycle.finishWorkflow(runToken);
			notify("plan-implement could not start an abortable run.", "error");
			return;
		}
		let retainedTab: string | undefined;
		const openRunner = async (cwd: string) => {
			const opened = await openAgentHost(
				{ owner: "plan-implement", label: `fast-${extractSlug(task)}`, cwd, maxAgents: 1 },
				{ exec: createNodeHerdrExec() },
			);
			if (!opened.ok) return opened;
			const runner = createRoleRunner(opened.host, {
				onStarted: (role, model, paneId) => {
					if (lifecycle.isCurrent(runToken)) {
						ctx.ui.setStatus("plan-implement", `plan-implement: ${role} ${model} · pane ${paneId}`);
					}
				},
				onBlocked: async (_role, paneId, signal) =>
					ctx.ui.confirm(
						"Implementer is waiting for input",
						`Answer the agent in pane ${paneId}, then continue. Decline to abort the run.`,
						{ signal },
					),
			});
			retainedTab = runner.tabId;
			return { ok: true as const, runner };
		};
		try {
			ctx.ui.setStatus("plan-implement", "plan-implement: preparing fast workstream…");
			const fastEffects = { backend, openRunner, signal: controller.signal, timeoutMinutes };
			const outcome =
				workLocation === "current"
					? await runFastCurrent({ task, changeKind, planFile }, implementer, ctx.cwd, fastEffects)
					: await runFastWorktree({ task, changeKind, planFile }, implementer, ctx.cwd, fastEffects);
			postFastOutcome(outcome, implementerModel, ctx);
		} finally {
			if (retainedTab && lifecycle.isSessionCurrent(runToken)) {
				notify(`Hosted implementer retained in Herdr tab ${retainedTab}.`, "info");
			}
			if (lifecycle.isCurrent(runToken)) ctx.ui.setStatus("plan-implement", undefined);
			lifecycle.endRole(runToken, controller);
			lifecycle.finishWorkflow(runToken);
		}
	}

	async function runPlanImplement(
		rawTask: string,
		mode: DeliveryMode,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		fast: boolean,
		adversary: boolean,
		planOnly: boolean,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const task = prepareTask(rawTask, ctx.ui.notify.bind(ctx.ui));
		if (task) {
			await runPreparedPlanImplement(task, mode, workLocation, changeKind, fast, adversary, planOnly, ctx);
		}
	}
	pi.registerCommand("plan-implement", {
		description: "Plan, approve, implement here or in --worktree, panel-review, fix findings, then publish a draft PR",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			const notify = ctx.ui.notify.bind(ctx.ui);
			if (ctx.mode !== "tui") {
				notify("plan-implement requires interactive TUI mode inside Herdr.", "error");
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
			const preflightError = parsed.fast || parsed.planOnly ? undefined : await checkBasicPreflights(ctx);
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
			if (task) {
				await runPreparedPlanImplement(
					task,
					mode,
					workLocation,
					changeKind,
					fast,
					parsed.adversary,
					parsed.planOnly,
					ctx,
					parsed.planFile,
				);
			}
		},
	});
	pi.events.on(PLAN_IMPLEMENT_REQUEST_EVENT, (data) => claimPlanImplementRequest(data, runPlanImplement));
}
