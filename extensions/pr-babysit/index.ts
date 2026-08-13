/**
 * Bounded PR Babysit extension for Pi.
 *
 * Watches over an open PR frontier using only tiny models (GPT-5.6 Luna,
 * Gemini 3.7 Flash, DeepSeek V4 Flash) recorded in kstack.json. Spawns
 * isolated child agents with those models to triage CI/check status and
 * review threads, generates fixes, commits, and pushes — stopping at
 * merge-ready. Never auto-merges, never re-stacks shared history.
 *
 * Command: /pr-babysit [--mode check|threads|drive|cleanup] [--pr <number>]
 * Config:  "pr-babysit" section of $PI_CODING_AGENT_DIR/kstack.json (see README.md)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { BabysitLifecycle } from "./lifecycle.ts";
import { resolveModels, loadConfig, modelCliId } from "./config.ts";
import { parseArgs } from "./command.ts";
import { runBabysit, type LifecyclePhase } from "./babysit.ts";
import { isChildModelAvailable } from "../plan-implement/model-availability.ts";
import type { BabysitMode, ExecFn, ExecFnResult } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");

/** Tiny models the babysitter is allowed to use — the exclusive child agent set. */
export { DEFAULT_TINY_MODELS } from "./config.ts";

function readPrompt(name: string): string {
	return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

interface PhaseDetails {
	schemaVersion: 1;
	mode: string;
	status: string;
	cycles: number;
	models: string[];
}

/** Exec wrapper forwarding the babysitter's per-call cwd/timeout to pi.exec. */
function makeExec(pi: ExtensionAPI): ExecFn {
	return (command, args, options) => pi.exec(command, args, { cwd: options.cwd, timeout: options.timeout }) as Promise<ExecFnResult>;
}

export default function prBabysitExtension(pi: ExtensionAPI): void {
	const lifecycle = new BabysitLifecycle();
	let abortController: AbortController | undefined;

	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => {
		abortController?.abort();
		abortController = undefined;
		lifecycle.shutdownSession();
	});

	pi.registerShortcut("ctrl+shift+b", {
		description: "Abort the running pr-babysit child agent",
		handler: async (ctx) => {
			if (abortController && !abortController.signal.aborted) {
				abortController.abort();
				ctx.ui.setStatus("pr-babysit", "pr-babysit: aborting child agent…");
			} else {
				ctx.ui.notify("No pr-babysit child agent is running.", "info");
			}
		},
	});

	pi.registerMessageRenderer("pr-babysit", (message, { expanded, outputPad }, theme) => {
		const details = message.details as PhaseDetails | undefined;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		const icon = theme.fg("success", "▢");
		const header = `${icon} ${theme.fg("accent", "PR Babysit")} ${theme.fg("muted", `— mode: ${details?.mode ?? "check"} — ${details?.status ?? "running"} — cycles: ${details?.cycles ?? 0}`)}`;
		if (!expanded) {
			box.addChild(new Text(`${header}${theme.fg("dim", " (Ctrl+O to expand)")}`, 0, 0));
			return box;
		}
		const lines = [
			`${icon} PR Babysit — ${details?.mode ?? "check"}`,
			"",
			`Status: ${details?.status ?? "running"}`,
			`Cycles: ${details?.cycles ?? 0}`,
			`Models: ${details?.models?.join(", ") ?? "(none)"}`,
			"",
			message.content,
		];
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});

	/** Send a phase-update message card to the TUI. */
	function sendPhaseMessage(pi: ExtensionAPI, mode: string, phase: LifecyclePhase, cycles: number, models: string[], content: string): void {
		const details: PhaseDetails = {
			schemaVersion: 1,
			mode,
			status: phase,
			cycles,
			models,
		};
		pi.sendMessage({
			customType: "pr-babysit",
			content,
			display: true,
			details,
		});
	}

	/** Core runner for a babysit request that has crossed validation/naming. */
	async function runBabysitCommand(
		mode: string,
		prNumber: number | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const notify = ctx.ui.notify.bind(ctx.ui);
		if (!ctx.hasUI) {
			notify("pr-babysit requires interactive (TUI/RPC) mode.", "error");
			return;
		}
		if (lifecycle.isRunning()) {
			notify("A pr-babysit run is already active. Press Ctrl+Shift+B to abort it.", "warning");
			return;
		}

		const sessionToken = lifecycle.currentSessionToken();
		if (!sessionToken) return;

		// Load and validate config.
		const configLoad = loadConfig();
		if (configLoad.status === "invalid") {
			notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
			return;
		}

		const modelDeps = {
			available: (provider: string, modelId: string) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
		};
		const modelResolution = resolveModels(configLoad, modelDeps);
		if (!modelResolution.ok) {
			notify(modelResolution.error, "error");
			return;
		}
		const config = modelResolution.config;

		for (const warning of config.warnings) notify(warning, "warning");

		// Confirm the run before starting.
		const modelsDisplay = config.models.map((m) => `  ${m.label}: ${modelCliId(m)}`).join("\n");
		const confirmed = await ctx.ui.confirm(
			`Run pr-babysit (${mode} mode)?`,
			`PR: ${prNumber ? `#${prNumber}` : "lowest unmerged (auto-detected)"}\n` +
				`Models (tiny only):\n${modelsDisplay}\n\n` +
				`Timeout: ${config.timeoutMinutes} min idle / ${config.maxRuntimeMinutes} max per child agent\n` +
				"Bounded invariants:\n" +
				"- Works the lowest unmerged PR first\n" +
				"- Stops at merge-ready (never auto-merges)\n" +
				"- Never rebases or force-pushes shared history\n" +
				"- Classifies CI failures before retrying\n" +
				"- Only tiny models (GPT-5.6 Luna, Gemini 3.7 Flash, DeepSeek V4 Flash)",
		);
		if (!lifecycle.isSessionCurrent(sessionToken) || !confirmed) return;

		const runToken = lifecycle.beginRun(sessionToken);
		if (!runToken) {
			notify("The session changed or another run started before confirmation completed.", "warning");
			return;
		}

		const abort = new AbortController();
		abortController = abort;

		let tempDir: string | undefined;
		const modelList = config.models.map((m) => m.label);

		try {
			tempDir = mkdtempSync(join(tmpdir(), "pi-pr-babysit-"));
			const triagerPromptFile = join(tempDir, "triager-prompt.md");
			const fixerPromptFile = join(tempDir, "fixer-prompt.md");
			writeFileSync(triagerPromptFile, readPrompt("triager.md"), { encoding: "utf8", mode: 0o600 });
			writeFileSync(fixerPromptFile, readPrompt("fixer.md"), { encoding: "utf8", mode: 0o600 });

			const updateStatus = (phase: LifecyclePhase) => {
				if (lifecycle.isCurrent(runToken)) {
					ctx.ui.setStatus("pr-babysit", `pr-babysit: ${phase}`);
					sendPhaseMessage(pi, mode, phase, 0, modelList, phase);
				}
			};

			const result = await runBabysit(
				mode as BabysitMode,
				{
					config,
					exec: makeExec(pi),
					cwd: ctx.cwd,
					explicitPR: prNumber,
					promptDir: tempDir,
					triagerPromptFile,
					fixerPromptFile,
				},
				{
					setPhase: (phase) => updateStatus(phase),
					notify: notify,
					confirm: (label, body) => ctx.ui.confirm(label, body),
				},
				abort.signal,
			);

			if (lifecycle.isCurrent(runToken)) {
				ctx.ui.setStatus("pr-babysit", undefined);
				if (result.status === "merge-ready") {
					notify(
						`PR babysit complete — PR #${result.prState?.number ?? "?"} is merge-ready. ` +
							"Stop at merge-ready; no merge performed. Use /session-archive to archive this session.",
						"info",
					);
					sendPhaseMessage(pi, mode, "idle", result.cyclesCompleted, modelList, "Merge-ready — stopped, not merged.");
				} else if (result.status === "cleaned") {
					notify("PR babysit cleanup complete. Managed worktree removed; session archive is manual.", "info");
				} else if (result.status === "blocked") {
					notify(
						`PR babysit blocked: ${result.blockedReasons.join("; ")}. ` +
							"These require human intervention. Run /pr-babysit --mode check to reassess.",
						"error",
					);
				} else if (result.status === "aborted") {
					notify("PR babysit aborted.", "info");
				} else {
					notify(`PR babysit ended: ${result.status}. ${result.blockedReasons.join("; ") || ""}`, result.status === "failed" ? "error" : "warning");
				}
			}
		} finally {
			abortController = undefined;
			lifecycle.endRun(runToken);
			if (tempDir) {
				try {
					rmSync(tempDir, { recursive: true, force: true });
				} catch {
					notify(`pr-babysit: could not remove temp dir ${tempDir}. Remove it manually.`, "warning");
				}
			}
			if (lifecycle.isCurrent(runToken)) ctx.ui.setStatus("pr-babysit", undefined);
		}
	}

	pi.registerCommand("pr-babysit", {
		description:
			"Babysit an open PR with tiny models only: /pr-babysit [--mode check|threads|drive|cleanup] [--pr <number>]. " +
			"Stops at merge-ready; never auto-merges or rebases shared history.",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const mode = parsed.args.mode;
			await runBabysitCommand(mode, parsed.args.pr, ctx);
		},
	});

	// Listen for in-process API requests from the router or other extensions.
	pi.events.on(PRBABYSIT_REQUEST_EVENT, (data) => {
		claimRequest(data, (mode, prNumber, ctx) => runBabysitCommand(mode, prNumber, ctx));
	});
}

// --- In-process API request contract ---

export const PRBABYSIT_REQUEST_EVENT = "kstack:pr-babysit:request";

export interface PrBabysitRequest {
	schemaVersion: 1;
	mode: string;
	prNumber: number | undefined;
	ctx: ExtensionCommandContext;
	claimed: boolean;
	completion?: Promise<void>;
}

export function isPrBabysitRequest(value: unknown): value is PrBabysitRequest {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<PrBabysitRequest>;
	return (
		r.schemaVersion === 1 &&
		typeof r.ctx === "object" &&
		r.ctx !== null &&
		typeof r.mode === "string" &&
		(r.prNumber === undefined || (typeof r.prNumber === "number" && r.prNumber > 0))
	);
}

export function claimRequest(
	value: unknown,
	run: (mode: string, prNumber: number | undefined, ctx: ExtensionCommandContext) => Promise<void>,
): boolean {
	if (!isPrBabysitRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.mode, value.prNumber, value.ctx);
	return true;
}
