/** Testable resolution and execution phases for panel-review. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ConfigLoad,
	DEFAULT_MAX_RUNTIME_MINUTES,
	DEFAULT_TIMEOUT_MINUTES,
	modelCliId,
	type ResolveDeps,
	resolveReviewers,
	resolveSynthesisModel,
} from "./config.ts";
import { runPanel } from "./orchestrator.ts";
import { type ChildEvent, runReviewer } from "./reviewer-runner.ts";
import { buildSynthesisInput, buildSynthesisPrompt, renderRawReports } from "./synthesis.ts";
import type { PanelArgs, PanelReviewOutcome, ReviewerSpec, ScopeBundle } from "./types.ts";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

export interface PanelResolution {
	reviewers: ReviewerSpec[];
	maxConcurrency: number;
	warnings: string[];
	synthesis: { model: string; thinking?: string; cliId: string };
	timeoutMinutes: number;
	maxRuntimeMinutes: number;
}

export function resolvePanel(
	configLoad: ConfigLoad,
	modelDeps: ResolveDeps,
): { ok: true; resolution: PanelResolution } | { ok: false; error: string; warnings: string[] } {
	if (configLoad.status === "invalid") {
		return { ok: false, error: `Invalid ${configLoad.path}: ${configLoad.error}`, warnings: [] };
	}
	const config = configLoad.status === "loaded" ? configLoad.config : null;
	const reviewers = resolveReviewers(config, modelDeps);
	if (!reviewers.ok) return { ok: false, error: reviewers.error, warnings: [] };
	const warnings = [...reviewers.warnings];
	const synthesis = resolveSynthesisModel(config, modelDeps);
	if (!synthesis.ok && configLoad.status === "loaded") {
		return { ok: false, error: synthesis.error, warnings };
	}
	if (!synthesis.ok) warnings.push(`${synthesis.error} Using the first reviewer model instead.`);
	else warnings.push(...synthesis.warnings);
	const model = synthesis.ok ? synthesis.model : reviewers.reviewers[0].model;
	const thinking = synthesis.ok ? synthesis.thinking : undefined;
	return {
		ok: true,
		resolution: {
			reviewers: reviewers.reviewers,
			maxConcurrency: reviewers.maxConcurrency,
			warnings,
			synthesis: { model, thinking, cliId: modelCliId({ label: "lead", model, thinking }) },
			timeoutMinutes: config?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
			maxRuntimeMinutes: config?.maxRuntimeMinutes ?? DEFAULT_MAX_RUNTIME_MINUTES,
		},
	};
}

export interface PipelineDashboard {
	markRunning(label: string): void;
	progress(label: string, info: { turns: number; activity?: string; preview?: string }): void;
	complete(label: string, info: { status: "completed" | "failed" | "aborted"; turns?: number; error?: string }): void;
	event(label: string, event: ChildEvent): void;
	note(label: string, text: string): void;
	addLead(label: string, name: string, model: string): void;
	tick(): void;
	dispose(): void;
}

export interface ReviewPipelineEffects {
	isCurrent(): boolean;
	notify(message: string, level: "info" | "warning" | "error"): void;
	setCompactStatus(status: string | undefined): void;
	createDashboard(reviewers: ReviewerSpec[]): PipelineDashboard | undefined;
	setActiveAbort(controller: AbortController): void;
	clearActiveAbort(controller: AbortController): void;
	waitForIdle(): Promise<void>;
	sendVerdict(verdict: string, details: VerdictDetails): void;
}

export interface VerdictDetails {
	schemaVersion: 1;
	baseSha: string;
	headSha: string;
	models: string[];
	reviewerStatuses: { label: string; model: string; status: string; error?: string }[];
	synthesisModel?: string;
	truncated: boolean;
	synthesized: boolean;
	contextFilesDisabled: boolean;
}

export interface ReviewPipelineOps {
	runPanel: typeof runPanel;
	runReviewer: typeof runReviewer;
}

const defaultPipelineOps: ReviewPipelineOps = { runPanel, runReviewer };

export async function runReviewPipeline(
	input: { scope: ScopeBundle; intent: string; options: PanelArgs; resolution: PanelResolution },
	fx: ReviewPipelineEffects,
	ops: ReviewPipelineOps = defaultPipelineOps,
): Promise<PanelReviewOutcome> {
	const { scope, intent, options, resolution } = input;
	let promptDir: string | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let abort: AbortController | undefined;
	const dashboard = fx.createDashboard(resolution.reviewers);
	try {
		promptDir = mkdtempSync(join(tmpdir(), "pi-panel-review-prompt-"));
		const reviewerPromptFile = join(promptDir, "reviewer-prompt.md");
		writeFileSync(reviewerPromptFile, assembleReviewerPrompt(), { encoding: "utf8", mode: 0o600 });
		abort = new AbortController();
		fx.setActiveAbort(abort);
		const progress = new Map<string, string>();
		let doneCount = 0;
		const startedAt = Date.now();
		const updateStatus = () => {
			if (!fx.isCurrent()) return;
			const lines = resolution.reviewers
				.map((reviewer) => `${reviewer.label}:${progress.get(reviewer.label) ?? "queued"}`)
				.join(" ");
			fx.setCompactStatus(
				`panel-review: ${doneCount}/${resolution.reviewers.length} done · ${Math.round((Date.now() - startedAt) / 1000)}s — ${lines}`,
			);
		};
		updateStatus();
		ticker = setInterval(() => {
			updateStatus();
			if (fx.isCurrent()) dashboard?.tick();
		}, 1000);
		ticker.unref?.();
		const childDeps = {
			timeoutMs: resolution.timeoutMinutes * 60_000,
			maxRuntimeMs: resolution.maxRuntimeMinutes * 60_000,
		};
		const panel = await ops.runPanel(resolution.reviewers, resolution.maxConcurrency, (spec) => {
			progress.set(spec.label, "running");
			updateStatus();
			if (fx.isCurrent()) {
				dashboard?.markRunning(spec.label);
				dashboard?.note(spec.label, "Reviewer started");
			}
			return ops
				.runReviewer({
					spec,
					model: modelCliId(spec),
					promptFile: reviewerPromptFile,
					task: `Review the bundle at ${scope.path}.`,
					cwd: scope.repoRoot,
					noContextFiles: scope.contextFilesTouched,
					signal: abort?.signal,
					deps: childDeps,
					onProgress: ({ label, turns, activity, preview }) => {
						progress.set(label, activity ? `${turns}t ${activity}` : `${turns}t`);
						updateStatus();
						if (fx.isCurrent())
							dashboard?.progress(label, {
								turns,
								...(activity ? { activity } : {}),
								...(preview !== undefined ? { preview } : {}),
							});
					},
					onEvent: (event) => {
						if (fx.isCurrent()) dashboard?.event(spec.label, event);
					},
				})
				.then((result) => {
					doneCount++;
					progress.set(spec.label, result.status === "completed" ? "✓" : result.status === "failed" ? "✗" : "aborted");
					updateStatus();
					if (fx.isCurrent()) {
						dashboard?.complete(spec.label, {
							status: result.status,
							turns: result.usage?.turns,
							...(result.status === "failed" ? { error: result.error } : {}),
						});
						dashboard?.note(
							spec.label,
							`Reviewer ${result.status}${result.status === "failed" ? `: ${result.error}` : ""}`,
						);
					}
					return result;
				});
		});
		clearInterval(ticker);
		ticker = undefined;
		fx.setCompactStatus(undefined);
		if (panel.aborted > 0 && panel.completed === 0 && panel.failed === 0) {
			fx.notify("Panel review aborted.", "info");
			return { status: "aborted" };
		}
		if (panel.completed === 0) {
			const diagnostics = panel.results
				.map(
					(result) =>
						`  ${result.label} (${result.model}): ${result.status}${result.status === "failed" ? ` — ${result.error}` : ""}`,
				)
				.join("\n");
			fx.notify(`All reviewers failed; nothing to synthesize.\n${diagnostics}`, "error");
			return { status: "failed", error: `All reviewers failed.\n${diagnostics}` };
		}
		const synthesis = resolution.synthesis;
		fx.setCompactStatus(`panel-review: synthesizing verdict with ${synthesis.cliId}…`);
		dashboard?.addLead("lead", "lead", synthesis.cliId);
		if (fx.isCurrent()) dashboard?.markRunning("lead");
		const { input: synthesisInput, truncated } = buildSynthesisInput({
			intent,
			scope,
			results: panel.results,
			approvedPlan: options.approvedPlan,
			executionLedger: options.executionLedger,
		});
		const synthesisInputFile = join(promptDir, "synthesis-input.md");
		writeFileSync(synthesisInputFile, synthesisInput, { encoding: "utf8", mode: 0o600 });
		const synthesisPromptFile = join(promptDir, "synthesis-prompt.md");
		writeFileSync(
			synthesisPromptFile,
			buildSynthesisPrompt(readPrompt("lead-judgment.md"), readPrompt("thermo-nuclear.md")),
			{ encoding: "utf8", mode: 0o600 },
		);
		const synthesisResult = await ops.runReviewer({
			spec: { label: "lead", model: synthesis.model, thinking: synthesis.thinking },
			model: synthesis.cliId,
			promptFile: synthesisPromptFile,
			task: `Synthesize the panel review in ${synthesisInputFile}. The repository root is ${scope.repoRoot}.`,
			cwd: scope.repoRoot,
			noContextFiles: scope.contextFilesTouched,
			signal: abort?.signal,
			deps: childDeps,
			onProgress: ({ turns, activity, preview }) => {
				if (fx.isCurrent())
					dashboard?.progress("lead", {
						turns,
						...(activity ? { activity } : {}),
						...(preview !== undefined ? { preview } : {}),
					});
			},
			onEvent: (event) => {
				if (fx.isCurrent()) dashboard?.event("lead", event);
			},
		});
		fx.setCompactStatus(undefined);
		if (fx.isCurrent()) {
			dashboard?.complete("lead", {
				status: synthesisResult.status,
				turns: synthesisResult.usage?.turns,
				...(synthesisResult.status === "failed" ? { error: synthesisResult.error } : {}),
			});
			dashboard?.note(
				"lead",
				`Synthesis ${synthesisResult.status}${synthesisResult.status === "failed" ? `: ${synthesisResult.error}` : ""}`,
			);
		}
		const synthesized = synthesisResult.status === "completed";
		const verdict = synthesized ? synthesisResult.output : renderRawReports(panel.results);
		if (!synthesized) {
			fx.notify(
				`Synthesis ${synthesisResult.status}${synthesisResult.status === "failed" ? `: ${synthesisResult.error}` : ""}. Preserving raw reviewer reports.`,
				"warning",
			);
		}
		const details: VerdictDetails = {
			schemaVersion: 1,
			baseSha: scope.baseSha,
			headSha: scope.headSha,
			models: resolution.reviewers.map(modelCliId),
			reviewerStatuses: panel.results.map((result) => ({
				label: result.label,
				model: result.model,
				status: result.status,
				...(result.status === "failed" ? { error: result.error } : {}),
			})),
			synthesisModel: synthesis.cliId,
			truncated: scope.truncated || truncated,
			synthesized,
			contextFilesDisabled: scope.contextFilesTouched,
		};
		await fx.waitForIdle();
		if (!fx.isCurrent()) return { status: "aborted" };
		fx.sendVerdict(verdict, details);
		return { status: "completed", verdict, synthesized, baseSha: scope.baseSha, headSha: scope.headSha };
	} finally {
		if (ticker) clearInterval(ticker);
		if (abort) fx.clearActiveAbort(abort);
		dashboard?.dispose();
		fx.setCompactStatus(undefined);
		if (promptDir) {
			try {
				rmSync(promptDir, { recursive: true, force: true });
			} catch {
				fx.notify(`panel-review: could not remove temp prompt dir ${promptDir}; remove it manually.`, "warning");
			}
		}
	}
}

function readPrompt(name: string): string {
	return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

function assembleReviewerPrompt(): string {
	return ["reviewer.md", "rubric.md", "code-quality.md", "thermo-nuclear.md"]
		.map((name) => readPrompt(name).trim())
		.join("\n\n---\n\n");
}
