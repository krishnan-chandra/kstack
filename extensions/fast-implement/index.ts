import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { makeExec } from "../shared/git-exec.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { SessionRunLifecycle } from "../shared/session-lifecycle.ts";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { claimFastImplementRequest, FAST_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { parseFastImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveRole } from "./config.ts";
import { runFastImplement } from "./runner.ts";
import type { FastImplementRequest } from "./types.ts";

export default function fastImplementExtension(pi: ExtensionAPI): void {
	const lifecycle = new SessionRunLifecycle();
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());

	pi.registerShortcut("ctrl+shift+a", {
		description: "Abort the running fast implementation child",
		handler: async (ctx) => {
			if (lifecycle.abortRun()) {
				ctx.ui.setStatus("fast-implement", "fast-implement: aborting child…");
			} else {
				ctx.ui.notify("No fast implementation child is running.", "info");
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
		const backend = createVcsBackend(vcsConfig.backend, makeExec(pi));
		const role = resolveRole(config.status === "loaded" ? config.config : null, (provider, model) =>
			isChildModelAvailable(ctx.modelRegistry, provider, model),
		);
		if (!role.ok) {
			ctx.ui.notify(role.error, "error");
			return;
		}
		// Claim exclusivity before the confirm await so overlapping command and
		// event requests cannot both start a child.
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
				"Run one fast implementation child?",
				`Implementer: ${modelCliId(role.role.implementer)}\nVCS backend: ${backend.id}\nChange kind: ${request.changeKind}\nLocation: ${request.workLocation === "worktree" ? "managed Git worktree" : backend.id === "jj" ? "current jj workspace" : "current Git checkout"}\nTimeout: ${role.role.timeoutMinutes} min\n\nFast mode skips independent planning and panel review, but still requires inspection, verification, and locally recorded changes. It never publishes automatically.`,
			);
			if (!confirmed || !lifecycle.isCurrent(runToken)) return;
			ctx.ui.setStatus("fast-implement", "fast-implement: implementing…");
			const outcome = await runFastImplement(request, role.role, ctx.cwd, {
				backend,
				signal: runSignal,
			});
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
		} finally {
			if (lifecycle.isCurrent(runToken)) ctx.ui.setStatus("fast-implement", undefined);
			lifecycle.endRun(runToken);
		}
	}

	pi.registerCommand("fast-implement", {
		description: "Implement a bounded change with one confirmed child and local commits",
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
