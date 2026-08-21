/** Panel Review extension: interactive adapter for isolated review phases. */

import { rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { getAgentPaneHost } from "../shared/agent-pane.ts";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { claimPanelReviewRequest, PANEL_REVIEW_REQUEST_EVENT } from "./api.ts";
import { getArgumentCompletions, parseArgs } from "./args.ts";
import { loadConfig, modelCliId } from "./config.ts";
import { PanelLifecycle, type PanelToken } from "./lifecycle.ts";
import { collectScope, defaultGitExec, requireWorkTree, resolveBase, type ScopeBundle } from "./review-scope.ts";
import { type PipelineDashboard, resolvePanel, runReviewPipeline, type VerdictDetails } from "./run-phases.ts";
import type { PanelArgs, PanelReviewOutcome, ReviewerSpec } from "./types.ts";

export default function (pi: ExtensionAPI): void {
	guardCommandFallthrough(pi, "panel-review");
	const lifecycle = new PanelLifecycle();
	const paneHost = getAgentPaneHost(pi);
	// Extensions normally load before session_start; eager activation also keeps
	// commands usable when an extension is loaded into an existing session.
	lifecycle.startSession();

	pi.registerMessageRenderer("panel-review", (message, { expanded, outputPad }, theme) => {
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const details = message.details as VerdictDetails | undefined;
		if (!expanded) {
			const statuses = details?.reviewerStatuses ?? [];
			const okCount = statuses.filter((status) => status.status === "completed").length;
			const header =
				theme.fg("success", "■ Panel review") +
				theme.fg("muted", ` — ${okCount}/${statuses.length} reviewers completed`) +
				(details?.truncated ? theme.fg("warning", " — scope truncated") : "") +
				(details && !details.synthesized ? theme.fg("warning", " — synthesis failed") : "") +
				theme.fg("dim", " (Ctrl+O to expand)");
			box.addChild(new Text(header, 0, 0));
			return box;
		}
		let evidence = "";
		if (details?.schemaVersion === 2) {
			const rows = details.childSessions.map((session) => {
				if (session.kind === "persisted") return `${session.label} (${session.role}): ${session.id}\n  ${session.file}`;
				return `${session.label} (${session.role}): not persisted — ${session.reason} (${session.id ?? "ID unavailable"})`;
			});
			evidence = `\n\n${theme.fg("accent", "Evidence sessions")}\n${rows.join("\n")}`;
		}
		box.addChild(new Text(`${theme.fg("success", "■ Panel review verdict")}\n\n${message.content}${evidence}`, 0, 0));
		return box;
	});

	const runPanelReview = async (options: PanelArgs, ctx: ExtensionCommandContext): Promise<PanelReviewOutcome> => {
		let runToken: PanelToken | undefined;
		const session = lifecycle.currentSessionToken();
		const isLive = () =>
			runToken ? lifecycle.isCurrent(runToken) : Boolean(session && lifecycle.isSessionCurrent(session));
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
		if (!session) {
			ctx.ui.notify("panel-review has no active session; try again after the session starts.", "error");
			return { status: "failed", error: "no active session" };
		}
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
		let base: ReturnType<typeof resolveBase>;
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
				notify(
					`No reviewable changes against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}). Commit, stage, or modify files first — or pass --base for a wider range.`,
					"info",
				);
				return { status: "no-changes" };
			}
			const resolution = panel.resolution;
			const reviewerList = resolution.reviewers
				.map((reviewer) => `  ${reviewer.label}: ${modelCliId(reviewer)}`)
				.join("\n");
			const confirmed = await ctx.ui.confirm(
				"Run panel review?",
				`Base: ${scope.baseRef} (${scope.baseSha.slice(0, 8)}, ${scope.baseStrategy})\n` +
					"Review lens: thermo-nuclear code quality\n" +
					`Changes: ${scope.fileCount} file(s), ${(scope.diffBytes / 1024).toFixed(0)} KiB diff, ${scope.untrackedCount} untracked${scope.truncated ? " — TRUNCATED bundle" : ""}\n` +
					`Reviewers:\n${reviewerList}\nSynthesis: ${resolution.synthesis.cliId}\n\n` +
					"Reviewers run in isolated read-only processes (read/grep/find/ls only, no bash, no extensions or skills). The repository is never modified. " +
					`A child silent for ${resolution.timeoutMinutes} min is killed as stalled (hard cap ${resolution.maxRuntimeMinutes} min); press Ctrl+Shift+X to abort mid-run.` +
					(scope.contextFilesTouched
						? "\n\nThe changeset modifies AGENTS.md/CLAUDE.md, so children run with --no-context-files to keep the reviewed content out of their instructions."
						: ""),
			);
			if (!confirmed) return { status: "declined" };
			if (!lifecycle.isSessionCurrent(session)) return { status: "aborted" };
			const activeRunToken = lifecycle.beginRun(session);
			if (!activeRunToken) {
				notify("A panel review is already active. Press Ctrl+Shift+X to abort it.", "warning");
				return { status: "failed", error: "a panel review is already running" };
			}
			runToken = activeRunToken;
			return await runReviewPipeline(
				{ scope, intent, options, resolution },
				{
					isCurrent: isLive,
					notify,
					setCompactStatus,
					createDashboard: (reviewers) => createDashboard(ctx, reviewers),
					runSignal: lifecycle.runSignal(activeRunToken),
					beginSynthesisPhase: () => lifecycle.beginNextPhase(activeRunToken),
					waitForIdle: () => ctx.waitForIdle(),
					sendVerdict: (verdict, details) =>
						pi.sendMessage({ customType: "panel-review", content: verdict, display: true, details }),
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
		description:
			"Review current changes with a strict panel of isolated read-only reviewers: /panel-review [--base <ref>] <intent>",
		getArgumentCompletions,
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) return ctx.ui.notify(parsed.error, "error");
			await runPanelReview(parsed.args, ctx);
		},
	});
	pi.events.on(PANEL_REVIEW_REQUEST_EVENT, (data) => claimPanelReviewRequest(data, runPanelReview));
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());

	function createDashboard(ctx: ExtensionCommandContext, reviewers: ReviewerSpec[]): PipelineDashboard | undefined {
		if (ctx.mode !== "tui") return undefined;
		const pane = paneHost.startRun({
			ctx,
			title: "Panel review",
			emptyMessage: "No panel children active",
			clearPreviewOnComplete: false,
			onAbort: () => {
				lifecycle.abortRun();
			},
		});
		for (const reviewer of reviewers) {
			pane.addChild({ id: reviewer.label, label: reviewer.label, model: modelCliId(reviewer) });
		}
		return {
			addLead: (id, label, model) => pane.addChild({ id, label, model, modelColor: "accent" }),
			markRunning: (id) => pane.markRunning(id),
			progress: (id, info) => pane.progress(id, info),
			complete: (id, info) => pane.complete(id, info),
			event: (id, event) => pane.event(id, event),
			note: (id, text) => pane.note(id, text),
			dispose: () => pane.dispose(),
		};
	}
}

function defaultGitExecSafe(args: string[], cwd: string): string {
	try {
		return defaultGitExec(args, cwd);
	} catch {
		return "";
	}
}
