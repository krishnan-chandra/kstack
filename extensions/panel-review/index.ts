/**
 * Panel Review extension for Pi.
 *
 * Runs 2–4 isolated, read-only Pi subagents in parallel against the same
 * Git changeset, then synthesizes their independent findings into one
 * lead-review verdict (Act On / Consider / Noted / Dismissed).
 *
 * Children run `pi --mode json -p --no-session` with discovery disabled and
 * only read,grep,find,ls tools — no bash, no write/edit, no extensions, no
 * skills. The full diff is never passed on a command line; it lives in a
 * mode-0600 temp bundle removed after the run.
 *
 * Command: /panel-review [--base <ref>] [--intent <text>]
 * Config:  $PI_CODING_AGENT_DIR/panel-review.json (see README.md)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseArgs } from "./args.ts";
import { loadConfig, modelCliId, resolveReviewers } from "./config.ts";
import { runPanel } from "./orchestrator.ts";
import { collectScope, defaultGitExec, requireWorkTree, resolveBase, type ScopeBundle } from "./review-scope.ts";
import { runReviewer } from "./reviewer-runner.ts";
import { buildSynthesisInput, buildSynthesisPrompt, renderRawReports } from "./synthesis.ts";
import type { ReviewerResult } from "./types.ts";

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
	].join("\n");
}

interface VerdictDetails {
	schemaVersion: 1;
	baseSha: string;
	headSha: string;
	models: string[];
	reviewerStatuses: { label: string; model: string; status: string }[];
	truncated: boolean;
	synthesized: boolean;
}

export default function (pi: ExtensionAPI) {
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

	pi.registerCommand("panel-review", {
		description: "Review current changes with a panel of isolated read-only reviewers: /panel-review [--base <ref>] [--intent <text>]",
		handler: async (args, ctx) => {
			const notify = ctx.ui.notify.bind(ctx.ui);
			if (!ctx.hasUI) {
				notify("panel-review requires interactive (TUI/RPC) mode.", "error");
				return;
			}
			await ctx.waitForIdle();

			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) {
				notify(parsed.error, "error");
				return;
			}

			// Git scope — before any model call.
			let repoRoot: string;
			try {
				repoRoot = requireWorkTree(defaultGitExec, ctx.cwd);
			} catch (err) {
				notify((err as Error).message, "error");
				return;
			}
			let base;
			try {
				base = resolveBase(defaultGitExec, repoRoot, parsed.args.base);
			} catch (err) {
				notify((err as Error).message, "error");
				return;
			}

			// Intent: from --intent, or an editor prefilled with commit subjects.
			let intent = parsed.args.intent?.trim() ?? "";
			if (!intent) {
				const subjects = defaultGitExecSafe(["log", "--format=%s", `${base.mergeBaseSha}..HEAD`], repoRoot);
				const prefill = subjects.trim() ? `Review these changes:\n${subjects.trim()}\n\nIntent: ` : "";
				const edited = await ctx.ui.editor("Panel review intent (required):", prefill);
				intent = edited?.trim() ?? "";
			}
			if (!intent) {
				notify("panel-review requires a non-empty intent.", "warning");
				return;
			}

			// Reviewer panel.
			const configLoad = loadConfig();
			if (configLoad.status === "invalid") {
				notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
				return;
			}
			const resolution = resolveReviewers(configLoad.status === "loaded" ? configLoad.config : null, {
				find: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
				scopedModels: ctx.scopedModels,
				activeModel: ctx.model,
			});
			if (!resolution.ok) {
				notify(resolution.error, "error");
				return;
			}
			for (const warning of resolution.warnings) notify(warning, "warning");

			let scope: ScopeBundle | undefined;
			let promptDir: string | undefined;
			try {
				scope = collectScope(repoRoot, base, intent);
				if (scope.fileCount === 0 && scope.diffBytes === 0 && scope.untrackedCount === 0) {
					notify(
						`No reviewable changes against ${scope.baseRef} (${scope.baseSha.slice(0, 8)}). ` +
							"Commit, stage, or modify files first — or pass --base for a wider range.",
						"info",
					);
					return;
				}

				const reviewerList = resolution.reviewers.map((r) => `  ${r.label}: ${modelCliId(r)}`).join("\n");
				const confirmed = await ctx.ui.confirm(
					"Run panel review?",
					`Base: ${scope.baseRef} (${scope.baseSha.slice(0, 8)}, ${scope.baseStrategy})\n` +
						`Changes: ${scope.fileCount} file(s), ${(scope.diffBytes / 1024).toFixed(0)} KiB diff, ` +
						`${scope.untrackedCount} untracked${scope.truncated ? " — TRUNCATED bundle" : ""}\n` +
						`Reviewers:\n${reviewerList}\n\n` +
						"Reviewers run in isolated read-only processes (read/grep/find/ls only, no bash, " +
						"no extensions or skills). The repository is never modified.",
				);
				if (!confirmed) return;

				promptDir = mkdtempSync(join(tmpdir(), "pi-panel-review-prompt-"));
				const reviewerPromptFile = join(promptDir, "reviewer-prompt.md");
				writeFileSync(reviewerPromptFile, assembleReviewerPrompt(), { encoding: "utf8", mode: 0o600 });

				const abort = new AbortController();
				const task = `Review the bundle at ${scope.path}.`;
				const progress = new Map<string, string>();
				let doneCount = 0;
				const updateStatus = () => {
					const lines = resolution.reviewers.map((r) => `${r.label}:${progress.get(r.label) ?? "queued"}`).join(" ");
					ctx.ui.setStatus("panel-review", `panel-review: ${doneCount}/${resolution.reviewers.length} done — ${lines}`);
				};
				updateStatus();

				const panel = await runPanel(resolution.reviewers, resolution.maxConcurrency, (spec) => {
					progress.set(spec.label, "running");
					updateStatus();
					return runReviewer({
						spec,
						model: modelCliId(spec),
						promptFile: reviewerPromptFile,
						task,
						cwd: scope!.repoRoot,
						signal: abort.signal,
						onProgress: ({ label, turns }) => {
							progress.set(label, `${turns}t`);
							updateStatus();
						},
					}).then((result) => {
						doneCount++;
						progress.set(spec.label, result.status === "completed" ? "✓" : result.status === "failed" ? "✗" : "aborted");
						updateStatus();
						return result;
					});
				});

				ctx.ui.setStatus("panel-review", undefined);
				if (panel.aborted > 0 && panel.completed === 0 && panel.failed === 0) {
					notify("Panel review aborted.", "info");
					return;
				}
				if (panel.completed === 0) {
					const diag = panel.results
						.map((r) => `  ${r.label} (${r.model}): ${r.status}${r.status === "failed" ? ` — ${r.error}` : ""}`)
						.join("\n");
					notify(`All reviewers failed; nothing to synthesize.\n${diag}`, "error");
					return;
				}

				// Synthesize with the active model in an isolated child process.
				ctx.ui.setStatus("panel-review", "panel-review: synthesizing verdict…");
				const { input, truncated: synthTruncated } = buildSynthesisInput({
					intent,
					scope,
					results: panel.results,
				});
				const synthInputFile = join(promptDir, "synthesis-input.md");
				writeFileSync(synthInputFile, input, { encoding: "utf8", mode: 0o600 });
				const synthPromptFile = join(promptDir, "synthesis-prompt.md");
				writeFileSync(synthPromptFile, buildSynthesisPrompt(readPrompt("lead-judgment.md")), {
					encoding: "utf8",
					mode: 0o600,
				});
				const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : resolution.reviewers[0].model;
				const synthResult: ReviewerResult = await runReviewer({
					spec: { label: "lead", model: activeModel },
					model: activeModel,
					promptFile: synthPromptFile,
					task: `Synthesize the panel review in ${synthInputFile}. The repository root is ${scope.repoRoot}.`,
					cwd: scope.repoRoot,
					signal: abort.signal,
				});
				ctx.ui.setStatus("panel-review", undefined);

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
					reviewerStatuses: panel.results.map((r) => ({ label: r.label, model: r.model, status: r.status })),
					truncated: scope.truncated || synthTruncated,
					synthesized,
				};
				await ctx.waitForIdle();
				pi.sendMessage({ customType: "panel-review", content: verdict, display: true, details });
			} finally {
				ctx.ui.setStatus("panel-review", undefined);
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
		},
	});
}

function defaultGitExecSafe(args: string[], cwd: string): string {
	try {
		return defaultGitExec(args, cwd);
	} catch {
		return "";
	}
}
