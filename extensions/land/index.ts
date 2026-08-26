import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { issueAutopilotConfirmation, requestPrAutopilot } from "../pr-autopilot/api.ts";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { makeExec } from "../shared/git-exec.ts";
import { findOpenPullRequestByHead, getPullRequest, isMergeMethod } from "../shared/github.ts";
import { requestStackLanding } from "../shared/stack/channel.ts";
import { stackProviderFor } from "../shared/stack/provider.ts";
import type { VcsBackend, VcsResult } from "../shared/vcs/backend.ts";
import { loadVcsBackend, type VcsBackendConfig } from "../shared/vcs/config.ts";
import { createVcsBackend } from "../shared/vcs/factory.ts";
import { claimLandRequest, LAND_REQUEST_EVENT, type LandRequestPayload } from "./api.ts";
import { completeLandArgs, parseLandArgs } from "./command.ts";
import { getRepoMethod, type LandConfig, loadLandConfig } from "./config.ts";
import { LandLifecycle, StackLandingLifecycle } from "./lifecycle.ts";
import { runLand } from "./orchestrator.ts";
import { resolveImplicitPr } from "./pr-resolution.ts";
import { blockedLandResult } from "./result.ts";
import { routeLand } from "./routing.ts";
import { abortableSleep } from "./sleep.ts";
import { summarizeLandResult } from "./summary.ts";
import type { LandOptions, LandResult, MergeMethod } from "./types.ts";

function selectedMethod(value: string | undefined): MergeMethod | undefined {
	return isMergeMethod(value) ? value : undefined;
}

export default function landExtension(pi: ExtensionAPI): void {
	guardCommandFallthrough(pi, "land");
	const lifecycle = new LandLifecycle();
	const stackLandingLifecycle = new StackLandingLifecycle();
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => {
		stackLandingLifecycle.abort();
		lifecycle.shutdownSession();
	});
	pi.registerShortcut("ctrl+shift+l", {
		description: "Abort active landing wait/subprocess",
		handler: async (ctx) => {
			const landAborted = lifecycle.abort();
			const stackAborted = stackLandingLifecycle.abort();
			const aborted = landAborted || stackAborted;
			ctx.ui.notify(
				aborted ? "Aborting landing. Accepted merges cannot be undone." : "No landing run is active.",
				"info",
			);
		},
	});
	pi.registerMessageRenderer("land", (message, { expanded, outputPad }, theme) => {
		const details =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ message.details as LandResult;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const summary = summarizeLandResult(details);
		box.addChild(new Text(expanded ? `${summary}\n${message.content}` : summary, 0, 0));
		return box;
	});

	async function configuredBackend(
		ctx: ExtensionContext,
		cwd: string,
	): Promise<VcsResult<{ backend: VcsBackend; config: VcsBackendConfig }>> {
		const config = loadVcsBackend();
		for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
		const backend = createVcsBackend(config.backend, makeExec(pi));
		const preflight = await backend.preflight(cwd);
		return preflight.ok ? { ok: true, backend, config } : preflight;
	}

	function landConfigFor(ctx: ExtensionContext): LandConfig {
		const loaded = loadLandConfig();
		if (loaded.status === "invalid") ctx.ui.notify(`Invalid ${loaded.path}: ${loaded.error}`, "error");
		return loaded.status === "loaded" ? loaded.config : { repos: {} };
	}

	async function runSingle(request: LandRequestPayload): Promise<LandResult> {
		const { ctx } = request;
		const options = request.options;
		const token = lifecycle.begin();
		if (!token) return blockedLandResult("Another landing run is active.");
		const cwd = options.cwd ?? ctx.cwd;
		const signals = [token.signal, request.kind === "stack-frontier" ? request.signal : undefined, ctx.signal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		const autopilotConfirmation = request.kind === "stack-frontier" ? issueAutopilotConfirmation() : undefined;
		const landConfig = request.kind === "interactive" ? landConfigFor(ctx) : undefined;
		ctx.ui.setStatus("land", "land: resolving target");
		try {
			return await runLand(
				request.kind === "stack-frontier"
					? { kind: "stack-frontier", options: request.options, expectedHeadSha: request.expectedHeadSha }
					: { kind: "interactive", options: request.options },
				{
					exec: makeExec(pi),
					cwd,
					signal,
					runAutopilot: (mode, pr) => requestPrAutopilot(pi, mode, pr, ctx, cwd, autopilotConfirmation, signal),
					selectMethod: async (allowed) =>
						selectedMethod(await ctx.ui.select("Select an allowed merge method", allowed)),
					confirmMerge: (body) => ctx.ui.confirm("Confirm exact PR merge/enqueue?", body),
					configuredMethodFor: landConfig ? (nameWithOwner) => getRepoMethod(landConfig, nameWithOwner) : undefined,
					now: Date.now,
					sleep: abortableSleep,
				},
			);
		} finally {
			lifecycle.end(token);
			ctx.ui.setStatus("land", undefined);
		}
	}

	async function executeInteractive(
		options: LandOptions,
		ctx: ExtensionContext,
		prepared?: { backend: VcsBackend; config: VcsBackendConfig },
	): Promise<LandResult> {
		if (!ctx.hasUI) return blockedLandResult("Land requires interactive TUI/RPC mode.");
		const cwd = options.cwd ?? ctx.cwd;
		const resolved: VcsResult<{ backend: VcsBackend; config: VcsBackendConfig }> = prepared
			? { ok: true, ...prepared }
			: await configuredBackend(ctx, cwd);
		if (!resolved.ok) return blockedLandResult(resolved.error);
		const exec = makeExec(pi);
		const provider = stackProviderFor(resolved.config);
		return routeLand({
			provider,
			requestStackLanding: async () => {
				if (!provider) return { handled: false };
				const stackSignal = stackLandingLifecycle.begin();
				if (!stackSignal) {
					return {
						handled: true,
						outcome: { status: "stack", outcome: { status: "busy", message: "Another stack landing run is active." } },
					};
				}
				try {
					const selected = await getPullRequest(exec, cwd, options.target.prNumber, stackSignal);
					return await requestStackLanding(pi, {
						provider,
						input: {
							repositoryPath: cwd,
							prNumber: selected.number,
							headRef: selected.headRef,
							readiness: options.readiness,
							method: options.method,
							signal: stackSignal,
						},
						capabilities: {
							runAutopilot: (mode, pr) => requestPrAutopilot(pi, mode, pr, ctx, cwd, undefined, stackSignal),
						},
						ctx,
					});
				} finally {
					stackLandingLifecycle.end(stackSignal);
				}
			},
			runSingle: () => runSingle({ kind: "interactive", options, ctx }),
		});
	}

	async function executeRequest(
		request: LandRequestPayload,
		prepared?: { backend: VcsBackend; config: VcsBackendConfig },
	): Promise<LandResult> {
		let result: LandResult;
		if (!request.ctx.hasUI) {
			result = blockedLandResult("Land requires interactive TUI/RPC mode.");
		} else if (request.kind === "stack-frontier") {
			result = await runSingle(request);
		} else {
			result = await executeInteractive(request.options, request.ctx, prepared);
		}
		pi.sendMessage({
			customType: "land",
			content: [...result.blockers, ...(result.warnings ?? []), ...result.completedMutations].join("\n"),
			display: true,
			details: result,
		});
		return result;
	}

	pi.events.on(LAND_REQUEST_EVENT, (data) => claimLandRequest(data, executeRequest));
	pi.registerCommand("land", {
		description: "Land a merge-ready PR: /land [--pr N] [--method squash|rebase] [--readiness check|watch]",
		getArgumentCompletions: completeLandArgs,
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
			await executeRequest(
				{
					kind: "interactive",
					options: {
						target: { kind: "single", prNumber: pr.prNumber },
						readiness: parsed.args.readiness,
						method: parsed.args.method,
					},
					ctx,
				},
				{ backend, config: resolved.config },
			);
		},
	});
}
