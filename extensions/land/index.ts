import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { requestStackLanding } from "../jj-stacked-prs/api.ts";
import { requestPrAutopilot } from "../pr-autopilot/api.ts";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { makeExec } from "../shared/git-exec.ts";
import { findOpenPullRequestByHead, getPullRequest, isMergeMethod } from "../shared/github.ts";
import type { VcsBackend, VcsResult } from "../shared/vcs/backend.ts";
import { loadVcsBackend } from "../shared/vcs/config.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { claimLandRequest, LAND_REQUEST_EVENT } from "./api.ts";
import { parseLandArgs } from "./command.ts";
import { getRepoMethod, type LandConfig, loadLandConfig } from "./config.ts";
import { requestGraphiteStackLanding } from "./graphite-stack-landing.ts";
import { LandLifecycle } from "./lifecycle.ts";
import { runLand } from "./orchestrator.ts";
import { resolveImplicitPr } from "./pr-resolution.ts";
import { routeLand } from "./routing.ts";
import { abortableSleep } from "./sleep.ts";
import { summarizeLandResult } from "./summary.ts";
import type { LandOptions, LandResult, MergeMethod } from "./types.ts";

function selectedMethod(value: string | undefined): MergeMethod | undefined {
	return isMergeMethod(value) ? value : undefined;
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
	guardCommandFallthrough(pi, "land");
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
		const summary = summarizeLandResult(details);
		box.addChild(new Text(expanded ? `${summary}\n${message.content}` : summary, 0, 0));
		return box;
	});

	async function configuredBackend(ctx: ExtensionContext, cwd: string): Promise<VcsResult<{ backend: VcsBackend }>> {
		const config = loadVcsBackend();
		for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
		const backend = createVcsBackend(config.backend, makeExec(pi));
		const preflight = await backend.preflight(cwd);
		return preflight.ok ? { ok: true, backend } : preflight;
	}

	async function execute(
		options: LandOptions,
		ctx: ExtensionContext,
		preparedBackend?: VcsBackend,
	): Promise<LandResult> {
		if (!ctx.hasUI) return blocked("Land requires interactive TUI/RPC mode.");
		const cwd = options.cwd ?? ctx.cwd;
		const resolved: VcsResult<{ backend: VcsBackend }> = preparedBackend
			? { ok: true, backend: preparedBackend }
			: await configuredBackend(ctx, cwd);
		if (!resolved.ok) return blocked(resolved.error);
		const exec = makeExec(pi);
		const result = await routeLand(options, {
			backend: resolved.backend.id,
			requestStackLanding: async () => {
				const selected = await getPullRequest(exec, cwd, options.target.prNumber, ctx.signal);
				return requestStackLanding(
					pi,
					{
						repositoryPath: cwd,
						prNumber: selected.number,
						headBookmark: selected.headRef,
						readiness: options.readiness,
						method: options.method,
					},
					ctx,
				);
			},
			requestGraphiteStackLanding: async () => {
				const token = lifecycle.begin();
				if (!token) return { status: "stack", outcome: blocked("Another landing run is active.") };
				ctx.ui.setStatus("land", "land: validating Graphite stack");
				try {
					return await requestGraphiteStackLanding(options, {
						exec,
						cwd,
						signal: token.signal,
						runAutopilot: (mode, pr) => requestPrAutopilot(pi, mode, pr, ctx, cwd, options.autopilotConfirmation),
						confirmMerge: (body) => ctx.ui.confirm("Confirm exact Graphite stack merge?", body),
						now: Date.now,
						sleep: abortableSleep,
					});
				} finally {
					lifecycle.end(token);
					ctx.ui.setStatus("land", undefined);
				}
			},
			runSingle: async () => {
				const token = lifecycle.begin();
				if (!token) return blocked("Another landing run is active.");
				ctx.ui.setStatus("land", "land: resolving target");
				const configLoad = loadLandConfig();
				if (configLoad.status === "invalid") {
					ctx.ui.notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
				}
				const landConfig: LandConfig = configLoad.status === "loaded" ? configLoad.config : { repos: {} };
				try {
					return await runLand(options, {
						exec,
						cwd,
						signal: token.signal,
						// Stack landing supplies separate capabilities for the exact merge
						// and for each frontier's autopilot pass.
						runAutopilot: (mode, pr) => requestPrAutopilot(pi, mode, pr, ctx, cwd, options.autopilotConfirmation),
						selectMethod: async (allowed) =>
							selectedMethod(await ctx.ui.select("Select an allowed merge method", allowed)),
						confirmMerge: (body) => ctx.ui.confirm("Confirm exact PR merge/enqueue?", body),
						configuredMethodFor: (nameWithOwner) => getRepoMethod(landConfig, nameWithOwner),
						now: Date.now,
						sleep: abortableSleep,
					});
				} finally {
					lifecycle.end(token);
					ctx.ui.setStatus("land", undefined);
				}
			},
		});
		pi.sendMessage({
			customType: "land",
			content: [...result.blockers, ...result.completedMutations].join("\n"),
			display: true,
			details: result,
		});
		return result;
	}

	pi.events.on(LAND_REQUEST_EVENT, (data) => claimLandRequest(data, execute));
	pi.registerCommand("land", {
		description: "Land a merge-ready PR: /land [--pr N] [--method squash|rebase] [--readiness check|watch]",
		getArgumentCompletions: (prefix) =>
			["--method squash", "--method rebase", "--readiness check", "--readiness watch"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (text, ctx) => {
			await ctx.waitForIdle();
			const parsed = parseLandArgs(text ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const resolved = await configuredBackend(ctx, ctx.cwd);
			if (!resolved.ok) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			const backend = resolved.backend;
			const pr = await resolveImplicitPr({
				explicitPr: parsed.args.pr,
				currentRef: () => backend.currentRef(ctx.cwd),
				findByHead: (ref) => findOpenPullRequestByHead(makeExec(pi), ctx.cwd, ref),
			});
			if (!pr.ok) {
				ctx.ui.notify(pr.message, "error");
				return;
			}
			await execute(
				{
					target: { kind: "single", prNumber: pr.prNumber },
					readiness: parsed.args.readiness,
					method: parsed.args.method,
				},
				ctx,
				backend,
			);
		},
	});
}
