import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import { makeExec } from "../shared/git-exec.ts";
import { createGitBackend } from "../shared/vcs/git-backend.ts";
import { claimLandRequest, LAND_REQUEST_EVENT } from "./api.ts";
import { parseLandArgs } from "./command.ts";
import { findOpenPullRequestByHead } from "./github.ts";
import { LandLifecycle } from "./lifecycle.ts";
import { runLand } from "./orchestrator.ts";
import { abortableSleep } from "./sleep.ts";
import type { LandOptions, LandResult, MergeMethod } from "./types.ts";

function selectedMethod(value: string | undefined): MergeMethod | undefined {
	return value === "merge" || value === "squash" || value === "rebase" ? value : undefined;
}

function blocked(reason: string): LandResult {
	return {
		status: "blocked",
		frontiers: [],
		autopilotRan: false,
		remainingBookmarks: [],
		completedMutations: [],
		blockers: [reason],
	};
}

export default function landExtension(pi: ExtensionAPI): void {
	const lifecycle = new LandLifecycle();
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());
	pi.registerShortcut("ctrl+shift+l", {
		description: "Abort active landing wait/subprocess",
		handler: async (ctx) => {
			ctx.ui.notify(
				lifecycle.abort() ? "Aborting landing. Accepted merges cannot be undone." : "No landing run is active.",
				"info",
			);
		},
	});
	pi.registerMessageRenderer("land", (message, { expanded, outputPad }, theme) => {
		const details = message.details as LandResult;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const summary = `Land — ${details.status} — ${details.frontiers.length} frontier(s)`;
		box.addChild(new Text(expanded ? `${summary}\n${message.content}` : summary, 0, 0));
		return box;
	});

	async function execute(options: LandOptions, ctx: ExtensionCommandContext): Promise<LandResult> {
		if (!ctx.hasUI) return blocked("Land requires interactive TUI/RPC mode.");
		const token = lifecycle.begin();
		if (!token) return blocked("Another landing run is active.");
		ctx.ui.setStatus("land", "land: resolving target");
		const cwd = options.cwd ?? ctx.cwd;
		try {
			const result = await runLand(options, {
				exec: makeExec(pi),
				cwd,
				signal: token.signal,
				runAutopilot: (mode, pr) => requestPrAutopilot(pi, mode, pr, ctx, cwd),
				selectMethod: async (allowed) => selectedMethod(await ctx.ui.select("Select an allowed merge method", allowed)),
				confirmMerge: (body) => ctx.ui.confirm("Confirm exact PR merge/enqueue?", body),
				now: Date.now,
				sleep: abortableSleep,
			});
			pi.sendMessage({
				customType: "land",
				content: [...result.blockers, ...result.completedMutations].join("\n"),
				display: true,
				details: result,
			});
			return result;
		} finally {
			lifecycle.end(token);
			ctx.ui.setStatus("land", undefined);
		}
	}

	pi.events.on(LAND_REQUEST_EVENT, (data) => claimLandRequest(data, execute));
	pi.registerCommand("land", {
		description: "Land a merge-ready PR: /land [--pr N] [--method merge|squash|rebase] [--readiness check|watch]",
		getArgumentCompletions: (prefix) =>
			["--method merge", "--method squash", "--method rebase", "--readiness check", "--readiness watch"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (text, ctx) => {
			await ctx.waitForIdle();
			const parsed = parseLandArgs(text ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			let prNumber = parsed.args.pr;
			if (!prNumber) {
				const backend = createGitBackend(makeExec(pi));
				const current = await backend.currentRef(ctx.cwd);
				const ref = current.ok && current.ref.kind === "branch" ? current.ref.name : undefined;
				if (!ref) {
					ctx.ui.notify("Could not resolve a current Git branch; pass --pr explicitly.", "error");
					return;
				}
				try {
					prNumber = await findOpenPullRequestByHead(makeExec(pi), ctx.cwd, ref);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
			}
			await execute(
				{ target: { kind: "single", prNumber }, readiness: parsed.args.readiness, method: parsed.args.method },
				ctx,
			);
		},
	});
}
