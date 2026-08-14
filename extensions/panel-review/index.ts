/** Panel Review extension: interactive adapter for isolated review phases. */

import { rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { claimPanelReviewRequest, PANEL_REVIEW_REQUEST_EVENT } from "./api.ts";
import { parseArgs } from "./args.ts";
import { loadConfig, modelCliId } from "./config.ts";
import { mountPanelDashboard, PanelDashboardStore } from "./live-dashboard.ts";
import { PanelLifecycle, type PanelToken } from "./lifecycle.ts";
import { collectScope, defaultGitExec, requireWorkTree, resolveBase, type ScopeBundle } from "./review-scope.ts";
import { resolvePanel, runReviewPipeline, type PipelineDashboard, type VerdictDetails } from "./run-phases.ts";
import type { PanelArgs, PanelReviewOutcome, ReviewerSpec } from "./types.ts";

export default function (pi: ExtensionAPI): void {
	const lifecycle = new PanelLifecycle();
	let activeAbort: AbortController | undefined;

	pi.registerShortcut("ctrl+shift+x", {
		description: "Abort the running panel review",
		handler: async (ctx) => {
			if (activeAbort && !activeAbort.signal.aborted) {
				activeAbort.abort();
				if (ctx.mode !== "tui") {
					ctx.ui.setStatus("panel-review", "panel-review: aborting (SIGTERM, SIGKILL after grace)…");
				}
			} else {
				ctx.ui.notify("No panel review is running.", "info");
			}
		},
	});

	pi.registerMessageRenderer("panel-review", (message, { expanded, outputPad }, theme) => {
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const details = message.details as VerdictDetails | undefined;
		if (!expanded) {
			const statuses = details?.reviewerStatuses ?? [];
			const okCount = statuses.filter((status) => status.status === "completed").length;
			const header = theme.fg("success", "■ Panel review") +
				theme.fg("muted", ` — ${okCount}/${statuses.length} reviewers completed`) +
				(details?.truncated ? theme.fg("warning", " — scope truncated") : "") +
				(details && !details.synthesized ? theme.fg("warning", " — synthesis failed") : "") +
				theme.fg("dim", " (Ctrl+O to expand)");
			box.addChild(new Text(header, 0, 0));
			return box;
		}
		box.addChild(new Text(`${theme.fg("success", "■ Panel review verdict")}\n\n${message.content}`, 0, 0));
		return box;
	});

	const runPanelReview = async (options: PanelArgs, ctx: ExtensionCommandContext): Promise<PanelReviewOutcome> => {
		let runToken: PanelToken | undefined;
		const session = lifecycle.currentSessionToken();
		const isLive = () => runToken ? lifecycle.isCurrent(runToken) : Boolean(session && lifecycle.isSessionCurrent(session));
		const notify = (message: string, level: "info" | "warning" | "error") => {
			if (isLive()) ctx.ui.notify(message, level);
		};
		const setCompactStatus = (status: string | undefined) => {
			if (isLive() && ctx.mode !== "tui") ctx.ui.setStatus("panel-review", status);
		};
		if (!ctx.hasUI) {
			ctx.ui.notify("panel-review requires interactive (TUI/RPC) mode.", "error");
			return { status: "failed", error: "panel-review requires interactive (TUI/RPC) mode." };
		}
		if (!session) return { status: "failed", error: "no active session" };
		if (lifecycle.isRunning()) {
			notify("A panel review is already active. Press Ctrl+Shift+X to abort it.", "warning");
			return { status: "failed", error: "a panel review is already running" };
		}
		await ctx.waitForIdle();
		if (!lifecycle.isSessionCurrent(session)) return { status: "aborted" };

		let repoRoot: string;
		try {
			repoRoot = requireWorkTree(defaultGitExec, options.repositoryPath ?? ctx.cwd);
		} catch (error) {
			notify((error as Error).message, "error");
			return { status: "failed", error: (error as Error).message };
		}
		let base;
		try {
			base = resolveBase(defaultGitExec, repoRoot, options.base);
		} catch (error) {
			notify((error as Error).message, "error");
			return { status: "failed", error: (error as Error).message };
		}

		let intent = options.intent?.trim() ?? "";
		if (!intent) {
			const subjects = defaultGitExecSafe(["log", "--format=%s", `${base.mergeBaseSha}..HEAD`], repoRoot);
			const prefill = subjects.trim() ? `Review these changes:\n${subjects.trim()}\n\nIntent: ` : "";
			const edited = await ctx.ui.editor("Panel review intent (required):", prefill);
			if (!lifecycle.isSessionCurrent(session)) return { status: "aborted" };
			intent = edited?.trim() ?? "";
		}
		if (!intent) {
			notify("panel-review requires a non-empty intent.", "warning");
			return { status: "failed", error: "panel-review requires a non-empty intent." };
		}

		const panel = resolvePanel(loadConfig(), {
			find: (provider, modelId) => {
				const model = ctx.modelRegistry.find(provider, modelId);
				return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
			},
			scopedModels: ctx.scopedModels,
			activeModel: ctx.model,
		});
		if (!panel.ok) {
			for (const warning of panel.warnings) notify(warning, "warning");
			notify(panel.error, "error");
			return { status: "failed", error: panel.error };
		}
		for (const warning of panel.resolution.warnings) notify(warning, "warning");

		let scope: ScopeBundle | undefined;
		try {
			scope = collectScope(repoRoot, base, intent);
			if (scope.fileCount === 0 && scope.diffBytes === 0 && scope.untrackedCount === 0) {
				notify(`No reviewable changes against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}). Commit, stage, or modify files first — or pass --base for a wider range.`, "info");
				return { status: "no-changes" };
			}
			const resolution = panel.resolution;
			const reviewerList = resolution.reviewers.map((reviewer) => `  ${reviewer.label}: ${modelCliId(reviewer)}`).join("\n");
			const confirmed = await ctx.ui.confirm(
				"Run panel review?",
				`Base: ${scope.baseRef} (${scope.baseSha.slice(0, 8)}, ${scope.baseStrategy})\n` +
					"Review lens: thermo-nuclear code quality\n" +
					`Changes: ${scope.fileCount} file(s), ${(scope.diffBytes / 1024).toFixed(0)} KiB diff, ${scope.untrackedCount} untracked${scope.truncated ? " — TRUNCATED bundle" : ""}\n` +
					`Reviewers:\n${reviewerList}\nSynthesis: ${resolution.synthesis.cliId}\n\n` +
					"Reviewers run in isolated read-only processes (read/grep/find/ls only, no bash, no extensions or skills). The repository is never modified. " +
					`A child silent for ${resolution.timeoutMinutes} min is killed as stalled (hard cap ${resolution.maxRuntimeMinutes} min); press Ctrl+Shift+X to abort mid-run.` +
					(scope.contextFilesTouched ? "\n\nThe changeset modifies AGENTS.md/CLAUDE.md, so children run with --no-context-files to keep the reviewed content out of their instructions." : ""),
			);
			if (!confirmed) return { status: "declined" };
			if (!lifecycle.isSessionCurrent(session)) return { status: "aborted" };
			runToken = lifecycle.beginRun(session);
			if (!runToken) {
				notify("A panel review is already active. Press Ctrl+Shift+X to abort it.", "warning");
				return { status: "failed", error: "a panel review is already running" };
			}
			return await runReviewPipeline(
				{ scope, intent, options, resolution },
				{
					isCurrent: isLive,
					notify,
					setCompactStatus,
					createDashboard: (reviewers) => createDashboard(ctx, reviewers),
					setActiveAbort: (controller) => { activeAbort = controller; },
					waitForIdle: () => ctx.waitForIdle(),
					sendVerdict: (verdict, details) => pi.sendMessage({ customType: "panel-review", content: verdict, display: true, details }),
				},
			);
		} finally {
			if (scope) {
				try {
					rmSync(scope.dir, { recursive: true, force: true });
				} catch {
					notify(`panel-review: could not remove temp bundle ${scope.dir} (mode 0600); remove it manually.`, "warning");
				}
			}
			if (runToken) lifecycle.endRun(runToken);
		}
	};

	pi.registerCommand("panel-review", {
		description: "Review current changes with a strict panel of isolated read-only reviewers: /panel-review [--base <ref>] [--intent <text>]",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) return ctx.ui.notify(parsed.error, "error");
			await runPanelReview(parsed.args, ctx);
		},
	});
	pi.events.on(PANEL_REVIEW_REQUEST_EVENT, (data) => claimPanelReviewRequest(data, runPanelReview));
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => {
		activeAbort?.abort();
		activeAbort = undefined;
		lifecycle.shutdownSession();
	});
}

function createDashboard(ctx: ExtensionCommandContext, reviewers: ReviewerSpec[]): PipelineDashboard | undefined {
	if (ctx.mode !== "tui") return undefined;
	const store = new PanelDashboardStore();
	for (const reviewer of reviewers) store.addReviewer(reviewer.label, reviewer.label, modelCliId(reviewer));
	const dispose = mountPanelDashboard(ctx.ui, store, {
		stripTerminalSequences,
		truncateToWidth: (text, width) => truncateToWidth(text, width),
	});
	return {
		addLead: (id, label, model) => store.addLead(id, label, model),
		markRunning: (id) => store.markRunning(id),
		progress: (id, info) => store.progress(id, info),
		complete: (id, info) => store.complete(id, info),
		tick: () => store.tick(),
		dispose,
	};
}

function defaultGitExecSafe(args: string[], cwd: string): string {
	try { return defaultGitExec(args, cwd); } catch { return ""; }
}
