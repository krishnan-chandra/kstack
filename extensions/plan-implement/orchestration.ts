/** Plan-implement orchestration with Pi, Herdr, lifecycle, and path effects injected. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestLand } from "../land/api.ts";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import { type ChangeKind, changeKindLabel, changeKindPlaybookFile } from "../shared/change-kind.ts";
import { findOpenPullRequestByHead } from "../shared/github.ts";
import { runHeadlessAdversary, selectAdversaryTransport } from "../shared/herdr/adversary-runner.ts";
import type { openAgentHost, openPaneHost, preflightHerdr } from "../shared/herdr/agent-host.ts";
import type { createNodeHerdrExec } from "../shared/herdr/herdr-cli.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import { extractSlug } from "../shared/slug.ts";
import type { IsolationPlan, VcsBackend } from "../shared/vcs/backend.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";
import { vcsPolicy } from "../shared/vcs/policy.ts";
import { buildReviewInstructions } from "./adversary-review.ts";
import { createRoleRunner, type RoleRunner } from "./agent-runner.ts";
import { loadConfig, modelCliId, resolveAdversary, resolveImplementerOnly, resolveRoles } from "./config.ts";
import { type FastImplementOutcome, runFastCurrent, runFastWorktree } from "./fast-runner.ts";
import type { WorkflowLifecycle } from "./lifecycle.ts";
import { type AdversaryReviewRequest, runApprovedWorkflow } from "./phases.ts";
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

export interface HerdrEntryPoints {
	createExec: typeof createNodeHerdrExec;
	preflight: typeof preflightHerdr;
	openHost: typeof openAgentHost;
	openPane: typeof openPaneHost;
}

export interface OrchestrationDeps {
	pi: ExtensionAPI;
	lifecycle: WorkflowLifecycle;
	herdr: HerdrEntryPoints;
	backendFor: (id: VcsBackend["id"]) => VcsBackend;
	phaseLabels: Readonly<Record<AgentRole, string>>;
	sendPhaseMessage: (result: AgentRunResult) => void;
	discoveredSkillRefs: (ctx: ExtensionCommandContext) => SkillRef[];
	paths: { promptsDir: string; playbooksDir: string; adversaryPromptFile: string; reviewAdversaryPromptFile: string };
}

interface PlanImplementOrchestration {
	runPreparedPlanImplement: (
		task: string,
		mode: DeliveryMode,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		fast: boolean,
		adversary: boolean,
		planOnly: boolean,
		ctx: ExtensionCommandContext,
		planFile?: string,
	) => Promise<void>;
	runFastPrepared: (
		task: string,
		workLocation: WorkLocation,
		changeKind: ChangeKind,
		ctx: ExtensionCommandContext,
		vcsConfig: ReturnType<typeof loadVcsBackend>,
		planFile?: string,
	) => Promise<void>;
}

/* exported: adversary review transport contract */
interface AdversaryReviewEffects {
	openPane: typeof openPaneHost;
	createExec: typeof createNodeHerdrExec;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	onStarted: (role: AgentRole, model: string, paneId: string) => void;
	onBlocked: (role: AgentRole, paneId: string, signal?: AbortSignal) => Promise<boolean>;
	label: string;
}

function headlessToAgentRun(
	adversary: { model: string },
	result: Awaited<ReturnType<typeof runHeadlessAdversary>>,
): AgentRunResult {
	const session = result.session.kind === "persisted" ? result.session.file : undefined;
	const cleanup = result.cleanupError ? { cleanupError: result.cleanupError } : undefined;
	if (result.status === "completed")
		return {
			status: "completed",
			role: "adversary",
			model: adversary.model,
			output: result.output,
			usage: result.usage,
			...(session ? { session } : undefined),
			...cleanup,
		};
	if (result.status === "aborted")
		return {
			status: "aborted",
			role: "adversary",
			model: adversary.model,
			...(session ? { session } : undefined),
			...cleanup,
		};
	return {
		status: "failed",
		role: "adversary",
		model: adversary.model,
		error: result.error,
		...(session ? { session } : undefined),
		...cleanup,
	};
}

/* exported: adversary review transport contract */
interface AdversaryReviewController {
	run: (request: AdversaryReviewRequest) => Promise<AgentRunResult[]>;
	dispose: () => Promise<void>;
}

/** Resolve with `promise`, or with `onTimeout()` once `deadline` aborts first. */
function raceDeadline<T>(promise: Promise<T>, deadline: AbortSignal, onTimeout: () => T): Promise<T> {
	if (deadline.aborted) return Promise.resolve(onTimeout());
	return new Promise<T>((resolve) => {
		const onAbort = () => resolve(onTimeout());
		deadline.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				deadline.removeEventListener("abort", onAbort);
				resolve(value);
			},
			() => {
				deadline.removeEventListener("abort", onAbort);
				resolve(onTimeout());
			},
		);
	});
}

/**
 * Build the implementation-review transport. Inside Herdr the adversaries share
 * one pane split off the caller's pane; otherwise each is a headless Pi child.
 * The pane host is created lazily on the first round and reused across rounds.
 */
/* exported: adversary review transport contract */
export function createAdversaryReview(effects: AdversaryReviewEffects): AdversaryReviewController {
	if (selectAdversaryTransport() === "headless") {
		return {
			async run(request) {
				const deadline = AbortSignal.any([
					...(request.signal ? [request.signal] : []),
					AbortSignal.timeout(request.timeoutMs),
				]);
				return Promise.all(
					request.adversaries.map(async (adversary) => {
						const result = await runHeadlessAdversary({
							model: adversary.model,
							cwd: request.cwd,
							prompt: buildReviewInstructions(request),
							systemPromptFile: request.systemPromptFile,
							owner: "plan-implement",
							label: adversary.label,
							timeoutMs: request.timeoutMs,
							signal: deadline,
						});
						return headlessToAgentRun(adversary, result);
					}),
				);
			},
			async dispose() {},
		};
	}

	let pending: Promise<RoleRunner | undefined> | undefined;
	const discarded: Array<Promise<void>> = [];
	// A pane host is single-use per attempt: a cancelled or never-ready host is closed
	// (including the panes it split off) and a later round opens a fresh one. The cleanup
	// promise is tracked so the controller's dispose() waits for late hosts to settle.
	const discardHost = (): void => {
		const host = pending;
		pending = undefined;
		if (!host) return;
		discarded.push(
			host.then(
				async (runner) => {
					await runner?.dispose({ closeTab: true });
				},
				() => undefined,
			),
		);
	};
	const runnerFor = (cwd: string, maxAgents: number): Promise<RoleRunner | undefined> => {
		pending ??= (async () => {
			const opened = await effects.openPane(
				{ owner: "plan-implement", label: effects.label, cwd, maxAgents },
				{ exec: effects.createExec() },
			);
			if (!opened.ok) {
				effects.notify(opened.error, "error");
				return undefined;
			}
			return createRoleRunner(opened.host, { onStarted: effects.onStarted, onBlocked: effects.onBlocked });
		})();
		return pending;
	};

	return {
		async run(request) {
			const deadline = AbortSignal.any([
				...(request.signal ? [request.signal] : []),
				AbortSignal.timeout(request.timeoutMs),
			]);
			const runner = await raceDeadline(runnerFor(request.cwd, request.adversaries.length), deadline, () => undefined);
			if (!runner) {
				discardHost();
				return request.adversaries.map((adversary) => ({
					status: "failed" as const,
					role: "adversary" as const,
					model: adversary.model,
					error: "the adversary pane host was not ready before the review deadline.",
				}));
			}
			const instructions = buildReviewInstructions(request);
			// The deadline signal cancels any queued allocation or in-flight ask. Awaiting every
			// settled run means no cancelled work outlives the round's bundle, and a rejected run
			// becomes a failure instead of rejecting the whole round.
			const settled = await Promise.allSettled(
				request.adversaries.map((adversary, index) =>
					runner.run({
						role: "adversary",
						instance: `${index + 1}`,
						model: adversary.model,
						promptFile: request.systemPromptFile,
						taskFile: request.taskFile,
						planFile: request.planFile,
						ledgerFile: request.ledgerFile,
						cwd: request.cwd,
						timeoutMs: request.timeoutMs,
						instructions,
						signal: deadline,
					}),
				),
			);
			if (deadline.aborted) discardHost();
			return settled.map((entry, index) => {
				if (entry.status === "fulfilled") return entry.value;
				return {
					status: "failed" as const,
					role: "adversary" as const,
					model: request.adversaries[index].model,
					error: `the review run rejected: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`,
				};
			});
		},
		async dispose() {
			const runner = await pending;
			await runner?.dispose();
			// Wait for every discarded late host to open and close its panes before the
			// workflow finishes, so cleanup cannot outlive the session.
			await Promise.allSettled(discarded);
		},
	};
}

export function createPlanImplementOrchestration(deps: OrchestrationDeps): PlanImplementOrchestration {
	const { preflight: preflightHostedAgents } = deps.herdr;

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
		if (deps.lifecycle.isRunning()) {
			notify("A plan/implement run is already active.", "warning");
			return;
		}
		const commandSession = deps.lifecycle.currentSessionToken();
		if (!commandSession) {
			notify("plan-implement has no active session; try again after the session starts.", "error");
			return;
		}
		await ctx.waitForIdle();
		if (!deps.lifecycle.isSessionCurrent(commandSession)) return;
		const herdrExec = deps.herdr.createExec();
		const herdrPreflight = await preflightHostedAgents({ exec: herdrExec });
		if (!herdrPreflight.ok) {
			notify(herdrPreflight.error, "error");
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
		const backend = deps.backendFor(vcsConfig.backend);
		const policy = vcsPolicy(backend.id);
		const stackClient = createStackDeliveryClient(deps.pi, vcsConfig, ctx);
		const engineeringPrinciplesPrompt = readPromptAsset(deps.paths.playbooksDir, "engineering-principles.md");
		const playbookFile = changeKindPlaybookFile(changeKind);
		const playbookPrompt = playbookFile ? readPromptAsset(deps.paths.playbooksDir, playbookFile) : undefined;
		const backendPrompt = policy.childGuidance;
		const changePrompts = playbookPrompt
			? [engineeringPrinciplesPrompt, playbookPrompt, backendPrompt]
			: [engineeringPrinciplesPrompt, backendPrompt];
		if (!deps.lifecycle.isSessionCurrent(commandSession)) return;
		if (mode === "single") {
			const preflight = await backend.preflight(ctx.cwd);
			if (!deps.lifecycle.isSessionCurrent(commandSession)) return;
			if (!preflight.ok) {
				notify(preflight.error, "error");
				return;
			}
		}
		const discoveredSkills = deps.discoveredSkillRefs(ctx);
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
		const adversaryModels = adversaryResolution.adversary?.models ?? [];
		const adversaryModel = adversaryModels[0];
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
			if (!deps.lifecycle.isSessionCurrent(commandSession)) {
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
			if (!deps.lifecycle.isSessionCurrent(commandSession)) return;
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
		const opened = await deps.herdr.openHost(
			{ owner: "plan-implement", label: extractSlug(task), cwd: ctx.cwd, maxAgents },
			{ exec: herdrExec },
		);
		if (!opened.ok) {
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
			notify(opened.error, "error");
			return;
		}
		const host = opened.host;
		let confirmationTitle = "Run plan → implement → adversarial review → fix → publish?";
		if (planOnly) confirmationTitle = "Run planner and stop after the final plan?";
		else if (mode === "stack")
			confirmationTitle = "Run plan → implement (stacked PRs) → adversarial review → fix → publish?";
		else if (workLocation === "worktree") {
			confirmationTitle = "Run plan → implement in managed worktree → adversarial review → fix → publish?";
		}
		const confirmed = await ctx.ui.confirm(
			confirmationTitle,
			mode === "stack"
				? `Planner (read-only): ${plannerModel}\nAdversary: ${adversaryModel ?? "none"}\nImplementer (creates a local ${stackClient?.provider ?? "configured"} stack): ${planOnly ? "not run" : implementerModel}\nHerdr tab: ${host.tabId}\nChange kind: ${changeKindLabel(changeKind)}\nStack base: ${stackBaseLabel} @ ${trunkSha?.slice(0, 8) ?? "?"}\nTimeout: ${roles.timeoutMinutes} min per role`
				: `Planner (read-only): ${plannerModel}\nAdversary: ${adversaryModel ?? "none"}\nImplementer (${policy.taskWorkstreamSummary}): ${planOnly ? "not run" : implementerModel}\nHerdr tab: ${host.tabId}\nVCS backend: ${backend.id}\nChange kind: ${changeKindLabel(changeKind)}\n${worktreePlan ? `Location: ${worktreePlan.path}\nBranch: ${worktreePlan.ref}\nBase: ${worktreePlan.baseRef} @ ${worktreePlan.baseSha.slice(0, 8)}\n` : `Location: ${policy.currentWorkspaceLabel}\n`}Timeout: ${roles.timeoutMinutes} min per role`,
		);
		if (!deps.lifecycle.isSessionCurrent(commandSession) || !confirmed) {
			await host.dispose({ closeTab: true });
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
			return;
		}
		const token = deps.lifecycle.beginWorkflow(commandSession);
		if (!token) {
			await host.dispose({ closeTab: true });
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
			notify("The session changed or another plan/implement run started before confirmation completed.", "warning");
			return;
		}
		const runner = createRoleRunner(host, {
			onStarted: (role, model, paneId) => {
				if (deps.lifecycle.isCurrent(token)) {
					ctx.ui.setStatus("plan-implement", `plan-implement: ${role} ${model} · pane ${paneId}`);
				}
			},
			onBlocked: async (role, paneId, signal) =>
				ctx.ui.confirm(
					`${deps.phaseLabels[role]} is waiting for input`,
					`Answer the agent in pane ${paneId}, then continue. Decline to abort this phase.`,
					{ signal },
				),
		});
		const adversaryReview = createAdversaryReview({
			openPane: deps.herdr.openPane,
			createExec: deps.herdr.createExec,
			notify,
			label: extractSlug(task),
			onStarted: (role, model, paneId) => {
				if (deps.lifecycle.isCurrent(token)) {
					ctx.ui.setStatus("plan-implement", `plan-implement: ${role} ${model} · pane ${paneId}`);
				}
			},
			onBlocked: async (role, paneId, signal) =>
				ctx.ui.confirm(
					`${deps.phaseLabels[role]} is waiting for input`,
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
					promptsDir: deps.paths.promptsDir,
					plannerModel,
					adversaryModel,
					adversaryPromptFile: adversaryModel ? deps.paths.adversaryPromptFile : undefined,
					maxRounds,
					adversaryTimeoutMinutes,
					adversaryModels,
					reviewAdversaryPromptFile: deps.paths.reviewAdversaryPromptFile,
					reviewTimeoutMinutes: adversaryResolution.adversary?.reviewTimeoutMinutes,
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
					sendPhase: (result) => deps.sendPhaseMessage(result),
					isCurrent: () => deps.lifecycle.isCurrent(token),
					isSessionCurrent: () => deps.lifecycle.isSessionCurrent(token),
					beginRole: (phase) => deps.lifecycle.beginRole(token, phase),
					endRole: (controller) => deps.lifecycle.endRole(token, controller),
					backend,
					runAdversaries: (request) => adversaryReview.run(request),
					resolvePublishedPr: async (cwd) => {
						const current = await backend.currentRef(cwd);
						const head =
							current.ok && (current.ref.kind === "branch" || current.ref.kind === "bookmark") ? current.ref.name : "";
						if (!head) return { ok: false, error: "could not resolve the workflow branch or bookmark." };
						try {
							return {
								ok: true,
								prNumber: await findOpenPullRequestByHead(
									(command, args, options) => deps.pi.exec(command, args, options),
									cwd,
									head,
								),
							};
						} catch (error) {
							return { ok: false, error: error instanceof Error ? error.message : String(error) };
						}
					},
					requestLand: (prNumber, cwd) =>
						requestLand(deps.pi, { target: { kind: "single", prNumber }, readiness: "watch", cwd }, ctx),
					requestAutopilot: (prNumber, cwd) => requestPrAutopilot(deps.pi, "drive", prNumber, ctx, cwd),
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
			await adversaryReview.dispose();
			await runner.dispose();
			if (deps.lifecycle.isSessionCurrent(token)) {
				notify(`Hosted agents retained in Herdr tab ${runner.tabId}.`, "info");
			}
			deps.lifecycle.finishWorkflow(token);
			if (stackTempDir) rmSync(stackTempDir, { recursive: true, force: true });
		}
	}

	function postFastOutcome(outcome: FastImplementOutcome, implementerModel: string, ctx: ExtensionContext): void {
		const retained =
			outcome.status !== "completed" && (outcome.branch || outcome.cwd)
				? `\nRetained workstream: ${outcome.cwd ?? ctx.cwd}${outcome.branch ? ` (${outcome.branch})` : ""}${outcome.output ? `\n\n${outcome.output}` : ""}`
				: "";
		deps.pi.sendMessage({
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
		if (deps.lifecycle.isRunning()) {
			notify("A plan/implement run is already active.", "warning");
			return;
		}
		const fastSession = deps.lifecycle.currentSessionToken();
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
		const backend = deps.backendFor(vcsConfig.backend);
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
			`Implementer: ${implementerModel}\nVCS backend: ${backend.id}\nChange kind: ${changeKindLabel(changeKind)}\nLocation: ${workLocation === "current" ? policy.currentWorkspaceLabel : "managed Git worktree"}\nTimeout: ${timeoutMinutes} min\n\nFast mode skips planning, adversarial review, and publishing. It runs in a visible Herdr pane, verifies locally recorded changes, and never publishes automatically.`,
		);
		if (!deps.lifecycle.isSessionCurrent(fastSession) || !confirmed) return;
		const runToken = deps.lifecycle.beginWorkflow(fastSession);
		if (!runToken) {
			notify("A plan/implement run is already active.", "warning");
			return;
		}
		const controller = deps.lifecycle.beginRole(runToken, "implementing");
		if (!controller) {
			deps.lifecycle.finishWorkflow(runToken);
			notify("plan-implement could not start an abortable run.", "error");
			return;
		}
		let retainedTab: string | undefined;
		const openRunner = async (cwd: string) => {
			const opened = await deps.herdr.openHost(
				{ owner: "plan-implement", label: `fast-${extractSlug(task)}`, cwd, maxAgents: 1 },
				{ exec: deps.herdr.createExec() },
			);
			if (!opened.ok) return opened;
			const runner = createRoleRunner(opened.host, {
				onStarted: (role, model, paneId) => {
					if (deps.lifecycle.isCurrent(runToken)) {
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
			if (retainedTab && deps.lifecycle.isSessionCurrent(runToken)) {
				notify(`Hosted implementer retained in Herdr tab ${retainedTab}.`, "info");
			}
			if (deps.lifecycle.isCurrent(runToken)) ctx.ui.setStatus("plan-implement", undefined);
			deps.lifecycle.endRole(runToken, controller);
			deps.lifecycle.finishWorkflow(runToken);
		}
	}

	return { runPreparedPlanImplement, runFastPrepared };
}
