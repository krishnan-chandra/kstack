import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { nameSessionIfUnnamed } from "../shared/session-name.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { claimFastImplementRequest, FAST_IMPLEMENT_REQUEST_EVENT } from "./api.ts";
import { parseFastImplementArgs, validateTask } from "./command.ts";
import { loadConfig, modelCliId, resolveRole } from "./config.ts";
import { runFastImplement } from "./runner.ts";
import type { FastImplementRequest } from "./types.ts";

export default function fastImplementExtension(pi: ExtensionAPI): void {
	let active: AbortController | undefined;
	pi.on("session_shutdown", () => active?.abort());
	pi.registerShortcut("ctrl+shift+f", { description: "Abort the running fast implementation child", handler: async (ctx) => { if (active) { active.abort(); ctx.ui.setStatus("fast-implement", "fast-implement: aborting child…"); } else ctx.ui.notify("No fast implementation child is running.", "info"); } });
	pi.registerMessageRenderer("fast-implement", (message, { expanded, outputPad }, theme) => { const details = message.details as { status?: string; branch?: string } | undefined; const header = `${details?.status === "completed" ? theme.fg("success", "■") : theme.fg("error", "■")} ${theme.fg("accent", "Fast implement")}${theme.fg("muted", ` — ${details?.branch ?? "no workstream"}`)}`; const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text)); box.addChild(new Text(expanded ? `${header}\n\n${message.content}` : `${header}${theme.fg("dim", " (Ctrl+O to expand)")}`, 0, 0)); return box; });
	async function run(request: FastImplementRequest, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) { ctx.ui.notify("fast-implement requires interactive TUI or RPC mode.", "error"); return; }
		if (active) { ctx.ui.notify("A fast implementation run is already active.", "warning"); return; }
		const config = loadConfig(); if (config.status === "invalid") { ctx.ui.notify(`Invalid ${config.path}: ${config.error}`, "error"); return; }
		const role = resolveRole(config.status === "loaded" ? config.config : null, (provider, model) => isChildModelAvailable(ctx.modelRegistry, provider, model)); if (!role.ok) { ctx.ui.notify(role.error, "error"); return; }
		// Claim exclusivity before the confirm await so overlapping command and
		// event requests cannot both pass the `active` check.
		const controller = new AbortController();
		active = controller;
		try {
			const confirmed = await ctx.ui.confirm("Run one fast implementation child?", `Implementer: ${modelCliId(role.role.implementer)}\nChange kind: ${request.changeKind}\nLocation: ${request.workLocation === "worktree" ? "managed worktree" : "current checkout"}\nTimeout: ${role.role.timeoutMinutes} min\n\nFast mode skips independent planning and panel review, but still requires inspection, verification, and local commits. It never publishes automatically.`); if (!confirmed) return;
			ctx.ui.setStatus("fast-implement", "fast-implement: implementing…");
			const outcome = await runFastImplement(request, role.role, ctx.cwd, { exec: (command, args, options) => pi.exec(command, args, options), signal: controller.signal });
			const retained = outcome.status !== "completed" && (outcome.branch || outcome.cwd) ? `\nRetained workstream: ${outcome.cwd ?? ctx.cwd}${outcome.branch ? ` (${outcome.branch})` : ""}` : "";
			pi.sendMessage({ customType: "fast-implement", content: outcome.status === "completed" ? outcome.output : `${outcome.error}${retained}`, display: true, details: { status: outcome.status, branch: outcome.branch } });
			ctx.ui.notify(outcome.status === "completed" ? `Fast implementation completed on ${outcome.branch}.` : `Fast implementation ${outcome.status}; ${retained ? "inspect the retained workstream." : "no workstream was created."}`, outcome.status === "completed" ? "info" : "error");
		} finally { active = undefined; ctx.ui.setStatus("fast-implement", undefined); }
	}
	pi.registerCommand("fast-implement", { description: "Implement a bounded change with one confirmed child and local commits", handler: async (args, ctx) => { const parsed = parseFastImplementArgs(args ?? ""); if (!parsed.ok) { ctx.ui.notify(parsed.error, "warning"); return; } nameSessionIfUnnamed(pi, parsed.request.task); await run(parsed.request, ctx); } });
	pi.events.on(FAST_IMPLEMENT_REQUEST_EVENT, (request) => claimFastImplementRequest(request, async (task, workLocation, changeKind, ctx) => { const valid = validateTask(task); if (!valid.ok) { ctx.ui.notify(valid.error, "warning"); return; } nameSessionIfUnnamed(pi, valid.task); await run({ task: valid.task, workLocation, changeKind }, ctx); }));
}
