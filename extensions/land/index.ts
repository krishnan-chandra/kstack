import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import { LAND_REQUEST_EVENT, claimLandRequest } from "./api.ts";
import { parseLandArgs } from "./command.ts";
import { LandLifecycle } from "./lifecycle.ts";
import { runLand } from "./orchestrator.ts";
import type { ExecFn, LandOptions, LandResult, MergeMethod } from "./types.ts";
function makeExec(pi: ExtensionAPI): ExecFn { return (command, args, options) => pi.exec(command, args, options); }
async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> { const out = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 15_000 }); return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : undefined; }
export default function landExtension(pi: ExtensionAPI): void {
	const lifecycle = new LandLifecycle(); lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession()); pi.on("session_shutdown", () => lifecycle.shutdown());
	pi.registerShortcut("ctrl+shift+l", { description: "Abort active landing wait/subprocess", handler: async (ctx) => { ctx.ui.notify(lifecycle.abort() ? "Aborting landing. Accepted merges cannot be undone." : "No landing run is active.", "info"); } });
	pi.registerMessageRenderer("land", (message, { expanded, outputPad }, theme) => { const d = message.details as LandResult; const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t)); const summary = `Land — ${d.status} — ${d.frontiers.length} frontier(s)`; box.addChild(new Text(expanded ? `${summary}\n${message.content}` : summary, 0, 0)); return box; });
	async function execute(options: LandOptions, ctx: ExtensionCommandContext): Promise<LandResult> {
		if (!ctx.hasUI) return { status: "blocked", frontiers: [], autopilotRan: false, remainingBookmarks: [], completedMutations: [], blockers: ["Land requires interactive TUI/RPC mode."] };
		const token = lifecycle.begin(); if (!token) return { status: "blocked", frontiers: [], autopilotRan: false, remainingBookmarks: [], completedMutations: [], blockers: ["Another landing run is active."] };
		ctx.ui.setStatus("land", "land: resolving target");
		try { const result = await runLand(options, { exec: makeExec(pi), cwd: ctx.cwd, signal: token.signal, runAutopilot: (mode, pr) => requestPrAutopilot(pi, mode, pr, ctx), selectMethod: async (allowed) => { const selected = await ctx.ui.select("Select an allowed merge method", allowed); return selected as MergeMethod | undefined; }, confirmMerge: (body) => ctx.ui.confirm("Confirm exact PR merge/enqueue?", body), now: Date.now, sleep: (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); }) }); pi.sendMessage({ customType: "land", content: [...result.blockers, ...result.completedMutations].join("\n"), display: true, details: result }); return result; }
		finally { lifecycle.end(token); ctx.ui.setStatus("land", undefined); }
	}
	pi.events.on(LAND_REQUEST_EVENT, (data) => claimLandRequest(data, execute));
	pi.registerCommand("land", { description: "Land a merge-ready PR: /land [--pr N] [--top bookmark] [--method merge|squash|rebase] [--readiness check|watch]", getArgumentCompletions: (prefix) => ["--method merge", "--method squash", "--method rebase", "--readiness check", "--readiness watch"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })), handler: async (text, ctx) => { await ctx.waitForIdle(); const parsed = parseLandArgs(text ?? ""); if (!parsed.ok) { ctx.ui.notify(parsed.error, "error"); return; } if (parsed.args.top) { await execute({ target: { kind: "stack", topBookmark: parsed.args.top }, readiness: parsed.args.readiness, method: parsed.args.method }, ctx); return; } const branch = await currentBranch(pi, ctx.cwd); if (!branch) { ctx.ui.notify("Could not resolve the current Git branch; pass --top for a jj stack.", "error"); return; } if (!parsed.args.pr) { ctx.ui.notify("Automatic branch-to-PR resolution is not available; pass --pr explicitly.", "error"); return; } await execute({ target: { kind: "single", prNumber: parsed.args.pr, expectedHeadRef: branch }, readiness: parsed.args.readiness, method: parsed.args.method }, ctx); } });
}
