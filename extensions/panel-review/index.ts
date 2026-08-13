/**
 * Panel Review extension for Pi.
 *
 * Runs 2–5 isolated, read-only Pi subagents in parallel against the same
 * Git changeset, then synthesizes their independent findings into one
 * lead-review verdict (Act On / Consider / Noted / Dismissed).
 *
 * Children run `pi --mode json -p --no-session` with discovery disabled and
 * only read,grep,find,ls tools — no bash, no write/edit, no extensions, no
 * skills. The full diff is never passed on a command line; it lives in a
 * mode-0600 temp bundle removed after the run.
 *
 * Command: /panel-review [--base <ref>] [--intent <text>]
 * Config:  "panel-review" section of $PI_CODING_AGENT_DIR/kstack.json (see README.md)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { claimPanelReviewRequest, PANEL_REVIEW_REQUEST_EVENT } from "./api.ts";
import { parseArgs } from "./args.ts";
import { DEFAULT_MAX_RUNTIME_MINUTES, DEFAULT_TIMEOUT_MINUTES, loadConfig, modelCliId, resolveReviewers, resolveSynthesisModel } from "./config.ts";
import { runPanel } from "./orchestrator.ts";
import { mountPanelDashboard, PanelDashboardStore } from "./live-dashboard.ts";
import { collectScope, defaultGitExec, requireWorkTree, resolveBase, type ScopeBundle } from "./review-scope.ts";
import { runReviewer } from "./reviewer-runner.ts";
import { buildSynthesisInput, buildSynthesisPrompt, renderRawReports } from "./synthesis.ts";
import type { PanelArgs, PanelReviewOutcome, ReviewerResult } from "./types.ts";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

function readPrompt(name: string): string {
	return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

function assembleReviewerPrompt(): string {
	return [
		readPrompt("reviewer.md").trim(),
		"",
		"---",
		"",
		readPrompt("rubric.md").trim(),
		"",
		"---",
		"",
		readPrompt("code-quality.md").trim(),
		"",
		"---",
		"",
		readPrompt("thermo-nuclear.md").trim(),
	].join("\n");
}

interface VerdictDetails {
	schemaVersion: 1;
	baseSha: string;
	headSha: string;
	models: string[];
	reviewerStatuses: { label: string; model: string; status: string; error?: string }[];
	/** Model that produced the lead verdict (may differ from the reviewers'). */
	synthesisModel?: string;
	truncated: boolean;
	synthesized: boolean;
	/** Children ran with --no-context-files because the changeset edits them. */
	contextFilesDisabled: boolean;
}

export default function (pi: ExtensionAPI) {
	// Set while a panel run (reviewers or synthesis) is in flight.
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
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		const details = message.details as VerdictDetails | undefined;
		if (!expanded) {
			const statuses = details?.reviewerStatuses ?? [];
			const okCount = statuses.filter((s) => s.status === "completed").length;
			const header =
				theme.fg("success", "■ Panel review") +
				theme.fg("muted", ` — ${okCount}/${statuses.length} reviewers completed`) +
				(details?.truncated ? theme.fg("warning", " — scope truncated") : "") +
				(details && !details.synthesized ? theme.fg("warning", " — synthesis failed") : "") +
				theme.fg("dim", " (Ctrl+O to expand)");
			box.addChild(new Text(header, 0, 0));
			return box;
		}
		const header = theme.fg("success", "■ Panel review verdict");
		box.addChild(new Text(`${header}\n\n${message.content}`, 0, 0));
		return box;
	});

	const runPanelReview = async (options: PanelArgs, ctx: ExtensionCommandContext): Promise<PanelReviewOutcome> => {
			const notify = ctx.ui.notify.bind(ctx.ui);
			const setCompactStatus = (status: string | undefined) => {
				if (ctx.mode !== "tui") ctx.ui.setStatus("panel-review", status);
			};
			if (!ctx.hasUI) {
				notify("panel-review requires interactive (TUI/RPC) mode.", "error");
				return { status: "failed", error: "panel-review requires interactive (TUI/RPC) mode." };
			}
			await ctx.waitForIdle();

			// Git scope — before any model call.
			let repoRoot: string;
			try {
				repoRoot = requireWorkTree(defaultGitExec, options.repositoryPath ?? ctx.cwd);
			} catch (err) {
				notify((err as Error).message, "error");
				return { status: "failed", error: (err as Error).message };
			}
			let base;
			try {
				base = resolveBase(defaultGitExec, repoRoot, options.base);
			} catch (err) {
				notify((err as Error).message, "error");
				return { status: "failed", error: (err as Error).message };
			}

			// Intent: from --intent, or an editor prefilled with commit subjects.
			let intent = options.intent?.trim() ?? "";
			if (!intent) {
				const subjects = defaultGitExecSafe(["log", "--format=%s", `${base.mergeBaseSha}..HEAD`], repoRoot);
				const prefill = subjects.trim() ? `Review these changes:\n${subjects.trim()}\n\nIntent: ` : "";
				const edited = await ctx.ui.editor("Panel review intent (required):", prefill);
				intent = edited?.trim() ?? "";
			}
			if (!intent) {
				notify("panel-review requires a non-empty intent.", "warning");
				return { status: "failed", error: "panel-review requires a non-empty intent." };
			}

			// Reviewer panel.
			const configLoad = loadConfig();
			if (configLoad.status === "invalid") {
				notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
				return { status: "failed", error: `Invalid ${configLoad.path}: ${configLoad.error}` };
			}
			const modelDeps = {
				find: (provider: string, modelId: string) => {
					const m = ctx.modelRegistry.find(provider, modelId);
					// find() is catalog-only; require configured auth so unavailable
					// models are skipped (default panel) or rejected (config) up front.
					return m && ctx.modelRegistry.hasConfiguredAuth(m) ? m : undefined;
				},
				scopedModels: ctx.scopedModels,
				activeModel: ctx.model,
			};
			const resolution = resolveReviewers(configLoad.status === "loaded" ? configLoad.config : null, modelDeps);
			if (!resolution.ok) {
				notify(resolution.error, "error");
				return { status: "failed", error: resolution.error };
			}
			for (const warning of resolution.warnings) notify(warning, "warning");

			// Synthesis model (required in config). Without a config, fall back
			// from the built-in small, fast default to the panel's first model.
			const synthResolution = resolveSynthesisModel(configLoad.status === "loaded" ? configLoad.config : null, modelDeps);
			if (!synthResolution.ok) {
				if (configLoad.status === "loaded") {
					notify(synthResolution.error, "error");
					return { status: "failed", error: synthResolution.error };
				}
				notify(`${synthResolution.error} Using the first reviewer model instead.`, "warning");
			}
			for (const warning of synthResolution.warnings) notify(warning, "warning");
			const synthesisModel = synthResolution.ok ? synthResolution.model : resolution.reviewers[0].model;
			const synthesisThinking = synthResolution.ok ? synthResolution.thinking : undefined;
			const synthesisCliId = synthesisThinking ? `${synthesisModel}:${synthesisThinking}` : synthesisModel;
			const timeoutMinutes = configLoad.status === "loaded" ? configLoad.config.timeoutMinutes : DEFAULT_TIMEOUT_MINUTES;
			const maxRuntimeMinutes =
				configLoad.status === "loaded" ? configLoad.config.maxRuntimeMinutes : DEFAULT_MAX_RUNTIME_MINUTES;
			const childDeps = { timeoutMs: timeoutMinutes * 60_000, maxRuntimeMs: maxRuntimeMinutes * 60_000 };

			let scope: ScopeBundle | undefined;
			let promptDir: string | undefined;
			let ticker: ReturnType<typeof setInterval> | undefined;
			let runAbort: AbortController | undefined;
			let dashboard: PanelDashboardStore | undefined;
			let disposeDashboard: (() => void) | undefined;
			try {
				scope = collectScope(repoRoot, base, intent);
				if (scope.fileCount === 0 && scope.diffBytes === 0 && scope.untrackedCount === 0) {
					notify(
						`No reviewable changes against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}). ` +
							"Commit, stage, or modify files first — or pass --base for a wider range.",
						"info",
					);
					return { status: "no-changes" };
				}

				const reviewerList = resolution.reviewers.map((r) => `  ${r.label}: ${modelCliId(r)}`).join("\n");
				const confirmed = await ctx.ui.confirm(
					"Run panel review?",
					`Base: ${scope.baseRef} (${scope.baseSha.slice(0, 8)}, ${scope.baseStrategy})\n` +
						"Review lens: thermo-nuclear code quality\n" +
						`Changes: ${scope.fileCount} file(s), ${(scope.diffBytes / 1024).toFixed(0)} KiB diff, ` +
						`${scope.untrackedCount} untracked${scope.truncated ? " — TRUNCATED bundle" : ""}\n` +
						`Reviewers:\n${reviewerList}\n` +
						`Synthesis: ${synthesisCliId}\n\n` +
						"Reviewers run in isolated read-only processes (read/grep/find/ls only, no bash, " +
						"no extensions or skills). The repository is never modified. " +
						`A child silent for ${timeoutMinutes} min is killed as stalled (hard cap ${maxRuntimeMinutes} min); ` +
					"press Ctrl+Shift+X to abort mid-run." +
						(scope.contextFilesTouched
							? "\n\nThe changeset modifies AGENTS.md/CLAUDE.md, so children run with " +
								"--no-context-files to keep the reviewed content out of their instructions."
							: ""),
				);
				if (!confirmed) return { status: "declined" };

				// Live dashboard: TUI-only above-editor widget. Compact status is an
				// RPC fallback only, avoiding duplicate progress in the TUI footer.
				if (ctx.mode === "tui") {
					dashboard = new PanelDashboardStore();
					for (const r of resolution.reviewers) dashboard.addReviewer(r.label, r.label, modelCliId(r));
					disposeDashboard = mountPanelDashboard(ctx.ui, dashboard, {
						stripTerminalSequences,
						truncateToWidth: (text, width) => truncateToWidth(text, width),
					});
				}

				promptDir = mkdtempSync(join(tmpdir(), "pi-panel-review-prompt-"));
				const reviewerPromptFile = join(promptDir, "reviewer-prompt.md");
				writeFileSync(reviewerPromptFile, assembleReviewerPrompt(), { encoding: "utf8", mode: 0o600 });

				const abort = new AbortController();
				runAbort = abort;
				activeAbort = abort;
				const task = `Review the bundle at ${scope.path}.`;
				const progress = new Map<string, string>();
				let doneCount = 0;
				const startedAt = Date.now();
				const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
				const updateStatus = () => {
					const lines = resolution.reviewers.map((r) => `${r.label}:${progress.get(r.label) ?? "queued"}`).join(" ");
					setCompactStatus(`panel-review: ${doneCount}/${resolution.reviewers.length} done · ${elapsed()} — ${lines}`);
				};
				updateStatus();
				ticker = setInterval(() => {
					updateStatus();
					dashboard?.tick();
				}, 1000);
				ticker.unref?.();

				const panel = await runPanel(resolution.reviewers, resolution.maxConcurrency, (spec) => {
					progress.set(spec.label, "running");
					updateStatus();
					dashboard?.markRunning(spec.label);
					return runReviewer({
						spec,
						model: modelCliId(spec),
						promptFile: reviewerPromptFile,
						task,
						cwd: scope!.repoRoot,
						noContextFiles: scope!.contextFilesTouched,
						signal: abort.signal,
						deps: childDeps,
						onProgress: ({ label, turns, activity, preview }) => {
							progress.set(label, activity ? `${turns}t ${activity}` : `${turns}t`);
							updateStatus();
							dashboard?.progress(label, { turns, ...(activity ? { activity } : {}), ...(preview !== undefined ? { preview } : {}) });
						},
					}).then((result) => {
						doneCount++;
						progress.set(spec.label, result.status === "completed" ? "✓" : result.status === "failed" ? "✗" : "aborted");
						updateStatus();
						dashboard?.complete(spec.label, {
							status: result.status,
							turns: result.usage?.turns,
							...(result.status === "failed" && result.error ? { error: result.error } : {}),
						});
						return result;
					});
				});

				clearInterval(ticker);
				ticker = undefined;
				setCompactStatus(undefined);
				if (panel.aborted > 0 && panel.completed === 0 && panel.failed === 0) {
					notify("Panel review aborted.", "info");
					return { status: "aborted" };
				}
				if (panel.completed === 0) {
					const diag = panel.results
						.map((r) => `  ${r.label} (${r.model}): ${r.status}${r.status === "failed" ? ` — ${r.error}` : ""}`)
						.join("\n");
					notify(`All reviewers failed; nothing to synthesize.\n${diag}`, "error");
					return { status: "failed", error: `All reviewers failed.\n${diag}` };
				}

				// Synthesize with the configured synthesis model in an isolated child process.
				setCompactStatus(`panel-review: synthesizing verdict with ${synthesisCliId}…`);
				dashboard?.addLead("lead", "lead", synthesisCliId);
				dashboard?.markRunning("lead");
				const { input, truncated: synthTruncated } = buildSynthesisInput({
					intent,
					scope,
					results: panel.results,
				});
				const synthInputFile = join(promptDir, "synthesis-input.md");
				writeFileSync(synthInputFile, input, { encoding: "utf8", mode: 0o600 });
				const synthPromptFile = join(promptDir, "synthesis-prompt.md");
				writeFileSync(synthPromptFile, buildSynthesisPrompt(readPrompt("lead-judgment.md"), readPrompt("thermo-nuclear.md")), {
					encoding: "utf8",
					mode: 0o600,
				});
				const synthResult: ReviewerResult = await runReviewer({
					spec: { label: "lead", model: synthesisModel, thinking: synthesisThinking },
					model: synthesisCliId,
					promptFile: synthPromptFile,
					task: `Synthesize the panel review in ${synthInputFile}. The repository root is ${scope.repoRoot}.`,
					cwd: scope.repoRoot,
					noContextFiles: scope.contextFilesTouched,
					signal: abort.signal,
					deps: childDeps,
					onProgress: ({ turns, activity, preview }) => {
						dashboard?.progress("lead", { turns, ...(activity ? { activity } : {}), ...(preview !== undefined ? { preview } : {}) });
					},
				});
				setCompactStatus(undefined);
				dashboard?.complete("lead", {
					status: synthResult.status,
					turns: synthResult.usage?.turns,
					...(synthResult.status === "failed" && synthResult.error ? { error: synthResult.error } : {}),
				});

				const synthesized = synthResult.status === "completed";
				const verdict = synthesized ? synthResult.output : renderRawReports(panel.results);
				if (!synthesized) {
					notify(
						`Synthesis ${synthResult.status}${synthResult.status === "failed" ? `: ${synthResult.error}` : ""}. ` +
							"Preserving raw reviewer reports.",
						"warning",
					);
				}

				const details: VerdictDetails = {
					schemaVersion: 1,
					baseSha: scope.baseSha,
					headSha: scope.headSha,
					models: resolution.reviewers.map((r) => modelCliId(r)),
					reviewerStatuses: panel.results.map((r) => ({
						label: r.label,
						model: r.model,
						status: r.status,
						...(r.status === "failed" ? { error: r.error } : {}),
					})),
					synthesisModel: synthesisCliId,
					truncated: scope.truncated || synthTruncated,
					synthesized,
					contextFilesDisabled: scope.contextFilesTouched,
				};
				await ctx.waitForIdle();
				pi.sendMessage({ customType: "panel-review", content: verdict, display: true, details });
				return {
					status: "completed",
					verdict,
					synthesized,
					baseSha: scope.baseSha,
					headSha: scope.headSha,
				};
			} finally {
				if (ticker) clearInterval(ticker);
				if (runAbort && activeAbort === runAbort) activeAbort = undefined;
				disposeDashboard?.();
				disposeDashboard = undefined;
				dashboard = undefined;
				setCompactStatus(undefined);
				if (scope) {
					try {
						rmSync(scope.dir, { recursive: true, force: true });
					} catch {
						notify(`panel-review: could not remove temp bundle ${scope.dir} (mode 0600); remove it manually.`, "warning");
					}
				}
				if (promptDir) {
					try {
						rmSync(promptDir, { recursive: true, force: true });
					} catch {
						notify(`panel-review: could not remove temp prompt dir ${promptDir}; remove it manually.`, "warning");
					}
				}
			}
	};

	pi.registerCommand("panel-review", {
		description: "Review current changes with a strict panel of isolated read-only reviewers: /panel-review [--base <ref>] [--intent <text>]",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			await runPanelReview(parsed.args, ctx);
		},
	});

	pi.events.on(PANEL_REVIEW_REQUEST_EVENT, (data) => {
		claimPanelReviewRequest(data, runPanelReview);
	});

	pi.on("session_shutdown", () => {
		activeAbort?.abort();
		activeAbort = undefined;
	});
}

function defaultGitExecSafe(args: string[], cwd: string): string {
	try {
		return defaultGitExec(args, cwd);
	} catch {
		return "";
	}
}
