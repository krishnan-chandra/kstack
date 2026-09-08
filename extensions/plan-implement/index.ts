/** Thin Pi adapter for plan-implement registration, rendering, and lifecycle wiring. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { CHANGE_KINDS, type ChangeKind, isChangeKind } from "../shared/change-kind.ts";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { makeExec } from "../shared/git-exec.ts";
import { openAgentHost, preflightHerdr } from "../shared/herdr/agent-host.ts";
import { createNodeHerdrExec } from "../shared/herdr/herdr-cli.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import type { VcsBackend } from "../shared/vcs/backend.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { claimPlanImplementRequest, PLAN_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { getArgumentCompletions, parsePlanImplementArgs, validateTask } from "./command.ts";
import { WorkflowLifecycle } from "./lifecycle.ts";
import { createPlanImplementOrchestration, type HerdrEntryPoints, type OrchestrationDeps } from "./orchestration.ts";
import type { AgentRole, AgentRunResult, DeliveryMode, SkillRef, WorkLocation } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "..", "shared", "playbooks");
const ADVERSARY_PROMPT_FILE = join(EXTENSION_DIR, "..", "..", "skills", "adversarial-planning", "adversary-prompt.md");
const defaultHerdr: HerdrEntryPoints = {
	createExec: createNodeHerdrExec,
	preflight: preflightHerdr,
	openHost: openAgentHost,
};
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
export default function planImplementExtension(pi: ExtensionAPI, herdr: HerdrEntryPoints = defaultHerdr): void {
	guardCommandFallthrough(pi, "plan-implement");
	const lifecycle = new WorkflowLifecycle();
	const backendFor = (id: VcsBackend["id"]): VcsBackend => createVcsBackend(id, makeExec(pi));
	const { runPreparedPlanImplement } = createPlanImplementOrchestration({
		pi,
		lifecycle,
		herdr,
		backendFor,
		checkBasicPreflights,
		phaseLabels: PHASE_LABELS,
		sendPhaseMessage: (result) => sendPhaseMessage(pi, result),
		discoveredSkillRefs,
		paths: {
			promptsDir: PROMPTS_DIR,
			playbooksDir: PLAYBOOKS_DIR,
			adversaryPromptFile: ADVERSARY_PROMPT_FILE,
		},
	} satisfies OrchestrationDeps);
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
