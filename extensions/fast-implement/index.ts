import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { makeExec } from "../shared/git-exec.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { splitModelRef } from "../shared/model-spec.ts";
import { SessionRunLifecycle } from "../shared/session-lifecycle.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import type { VcsBackend } from "../shared/vcs/backend.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { claimFastImplementRequest, FAST_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { parseFastImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveRole } from "./config.ts";
import { buildImplementerGuidance, runWorktreeFastImplement } from "./runner.ts";
import {
	buildTakeoverKickoff,
	checkTakeoverSettlement,
	createTakeoverWorkstream,
	FAST_IMPLEMENT_RUN_COMPLETE_ENTRY,
	FAST_IMPLEMENT_RUN_ENTRY,
	type PendingFastImplementRun,
	preflightTakeoverWorkstream,
	TakeoverSettlementController,
} from "./takeover.ts";
import type { FastImplementOutcome, FastImplementRequest, ResolvedRole } from "./types.ts";

export default function fastImplementExtension(pi: ExtensionAPI): void {
	guardCommandFallthrough(pi, "fast-implement");
	const lifecycle = new SessionRunLifecycle();
	const backendFor = (id: VcsBackend["id"]): VcsBackend => createVcsBackend(id, makeExec(pi));
	const settlementController = new TakeoverSettlementController();
	lifecycle.startSession();
	pi.on("session_start", () => {
		settlementController.reset();
		lifecycle.startSession();
	});
	pi.on("session_shutdown", () => lifecycle.shutdownSession());

	pi.registerShortcut("ctrl+shift+a", {
		description: "Abort the running fast implementation worktree child",
		handler: async (ctx) => {
			if (lifecycle.abortRun()) {
				ctx.ui.setStatus("fast-implement", "fast-implement: aborting child…");
			} else {
				ctx.ui.notify("No fast implementation worktree child is running.", "info");
			}
		},
	});
	pi.registerMessageRenderer("fast-implement", (message, { expanded, outputPad }, theme) => {
		const details = message.details as { status?: string; branch?: string } | undefined;
		const header = `${details?.status === "completed" ? theme.fg("success", "■") : theme.fg("error", "■")} ${theme.fg("accent", "Fast implement")}${theme.fg("muted", ` — ${details?.branch ?? "no workstream"}`)}`;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(
			new Text(
				expanded ? `${header}\n\n${message.content}` : `${header}${theme.fg("dim", " (Ctrl+O to expand)")}`,
				0,
				0,
			),
		);
		return box;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const pending = settlementController.begin(ctx.sessionManager.getBranch());
		if (!pending) return;
		ctx.ui.setStatus("fast-implement", "fast-implement: verifying committed work…");
		const settlement = await checkTakeoverSettlement(pending, backendFor(pending.backend));
		if (settlement.kind === "pending") {
			ctx.ui.notify(
				`Fast implementation is not committed yet: ${settlement.reason} Continue working or steer the session; verification will retry after the next settle.`,
				"warning",
			);
			ctx.ui.setStatus("fast-implement", undefined);
			settlementController.finish(pending.runId);
			return;
		}
		await restorePreviousModel(pending, ctx);
		pi.appendEntry(FAST_IMPLEMENT_RUN_COMPLETE_ENTRY, { runId: pending.runId, status: "completed" });
		postOutcome(settlement.outcome, ctx);
		ctx.ui.setStatus("fast-implement", undefined);
		settlementController.finish(pending.runId);
	});

	async function restorePreviousModel(run: PendingFastImplementRun, ctx: ExtensionContext): Promise<void> {
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
			if ((await pi.setModel(previous)) && run.previousThinking) pi.setThinkingLevel(run.previousThinking);
		} catch {
			// Restoration is best effort after verified work.
		}
	}

	function postOutcome(outcome: FastImplementOutcome, ctx: ExtensionContext): void {
		const retained =
			outcome.status !== "completed" && (outcome.branch || outcome.cwd)
				? `\nRetained workstream: ${outcome.cwd ?? ctx.cwd}${outcome.branch ? ` (${outcome.branch})` : ""}`
				: "";
		pi.sendMessage({
			customType: "fast-implement",
			content: outcome.status === "completed" ? outcome.output : `${outcome.error}${retained}`,
			display: true,
			details: { status: outcome.status, branch: outcome.branch },
		});
		ctx.ui.notify(
			outcome.status === "completed"
				? `Fast implementation completed on ${outcome.branch}.`
				: `Fast implementation ${outcome.status}; ${retained ? "inspect the retained workstream." : "no workstream was created."}`,
			outcome.status === "completed" ? "info" : "error",
		);
	}

	async function startTakeover(
		request: FastImplementRequest,
		role: ResolvedRole,
		backend: VcsBackend,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const created = await createTakeoverWorkstream(backend, ctx.cwd, request.task);
		if (!created.ok) {
			postOutcome({ status: "failed", error: created.error }, ctx);
			return;
		}

		const cwd = ctx.cwd;
		const pending: PendingFastImplementRun = {
			schemaVersion: 1,
			runId: crypto.randomUUID(),
			task: request.task,
			changeKind: request.changeKind,
			backend: backend.id,
			cwd,
			checkpoint: created,
			implementerModel: role.implementer.model,
			...(ctx.model ? { previousModel: `${ctx.model.provider}/${ctx.model.id}` } : {}),
			...(ctx.thinkingLevel ? { previousThinking: ctx.thinkingLevel } : {}),
		};
		let kickoff: string;
		try {
			kickoff = buildTakeoverKickoff(pending, buildImplementerGuidance(request.changeKind, backend));
		} catch (error) {
			postOutcome(
				{
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					branch: created.ref,
					cwd,
				},
				ctx,
			);
			return;
		}

		const { provider, modelId } = splitModelRef(role.implementer.model);
		const targetModel = ctx.modelRegistry.find(provider, modelId);
		if (!targetModel) {
			postOutcome(
				{
					status: "failed",
					error: `Implementer ${role.implementer.model} is no longer available.`,
					branch: created.ref,
					cwd,
				},
				ctx,
			);
			return;
		}
		try {
			if (!(await pi.setModel(targetModel))) {
				postOutcome(
					{
						status: "failed",
						error: `No credentials are available for ${role.implementer.model}.`,
						branch: created.ref,
						cwd,
					},
					ctx,
				);
				return;
			}
			if (role.implementer.thinking) pi.setThinkingLevel(role.implementer.thinking);
			pi.appendEntry(FAST_IMPLEMENT_RUN_ENTRY, pending);
		} catch (error) {
			await restorePreviousModel(pending, ctx);
			postOutcome(
				{
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					branch: created.ref,
					cwd,
				},
				ctx,
			);
			return;
		}
		try {
			pi.sendUserMessage(kickoff);
		} catch (error) {
			ctx.ui.notify(
				`Fast implementation kickoff may have been accepted: ${error instanceof Error ? error.message : String(error)}. The run remains pending and will be verified when the session settles.`,
				"warning",
			);
		}
	}

	async function run(request: FastImplementRequest, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("fast-implement requires interactive TUI or RPC mode.", "error");
			return;
		}
		if (lifecycle.isRunning()) {
			ctx.ui.notify("A fast implementation run is already active.", "warning");
			return;
		}
		const session = lifecycle.currentSessionToken();
		if (!session) {
			ctx.ui.notify("fast-implement has no active session.", "error");
			return;
		}
		const config = loadConfig();
		if (config.status === "invalid") {
			ctx.ui.notify(`Invalid ${config.path}: ${config.error}`, "error");
			return;
		}
		const vcsConfig = loadVcsBackend();
		for (const warning of vcsConfig.warnings) ctx.ui.notify(warning, "warning");
		if (request.workLocation === "worktree" && vcsConfig.backend !== "git") {
			ctx.ui.notify("--worktree requires the git backend. The jj backend runs in the current workspace.", "error");
			return;
		}
		const backend = backendFor(vcsConfig.backend);
		const role = resolveRole(config.status === "loaded" ? config.config : null, (provider, model) =>
			isChildModelAvailable(ctx.modelRegistry, provider, model),
		);
		if (!role.ok) {
			ctx.ui.notify(role.error, "error");
			return;
		}
		const current = request.workLocation === "current";
		if (current) {
			const preflight = await preflightTakeoverWorkstream(backend, ctx.cwd);
			if (!preflight.ok) {
				postOutcome({ status: "failed", error: preflight.error }, ctx);
				return;
			}
		}
		const runToken = lifecycle.beginRun(session);
		if (!runToken) {
			ctx.ui.notify("A fast implementation run is already active.", "warning");
			return;
		}
		const runSignal = lifecycle.runSignal(runToken);
		if (!runSignal) {
			lifecycle.endRun(runToken);
			ctx.ui.notify("fast-implement could not start an abortable run.", "error");
			return;
		}
		try {
			const confirmed = await ctx.ui.confirm(
				current ? "Start fast implementation in this session?" : "Run one fast implementation worktree child?",
				`Implementer: ${modelCliId(role.role.implementer)}\nVCS backend: ${backend.id}\nChange kind: ${request.changeKind}\nLocation: ${current ? (backend.id === "jj" ? "current jj workspace" : "current Git checkout") : "managed Git worktree"}\nTimeout: ${current ? "none (interrupt or steer the session normally)" : `${role.role.timeoutMinutes} min`}\n\nFast mode skips independent planning and panel review, but still requires inspection, verification, and locally recorded changes. It never publishes automatically.${current ? " The implementation starts in this session, so its existing plan and discussion remain in context." : ""}`,
			);
			if (!confirmed || !lifecycle.isCurrent(runToken)) return;
			ctx.ui.setStatus(
				"fast-implement",
				current ? "fast-implement: starting in this session…" : "fast-implement: implementing…",
			);
			if (current) {
				await startTakeover(request, role.role, backend, ctx);
			} else {
				postOutcome(await runWorktreeFastImplement(request, role.role, ctx.cwd, { backend, signal: runSignal }), ctx);
			}
		} finally {
			if (lifecycle.isCurrent(runToken)) ctx.ui.setStatus("fast-implement", undefined);
			lifecycle.endRun(runToken);
		}
	}

	pi.registerCommand("fast-implement", {
		description: "Implement a bounded change in this session with local commits",
		handler: async (args, ctx) => {
			const parsed = parseFastImplementArgs(args ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			nameSessionIfUnnamed(pi, parsed.request.task);
			await run(parsed.request, ctx);
		},
	});
	pi.events.on(FAST_IMPLEMENT_REQUEST_EVENT, (request) =>
		claimFastImplementRequest(request, async (task, workLocation, changeKind, ctx) => {
			const valid = validateTask(task);
			if (!valid.ok) {
				ctx.ui.notify(valid.error, "warning");
				return;
			}
			nameSessionIfUnnamed(pi, valid.task);
			await run({ task: valid.task, workLocation, changeKind }, ctx);
		}),
	);
}
