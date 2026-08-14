/**
 * Bounded PR Autopilot extension for Pi.
 *
 * Watches over an open PR frontier using only tiny models (GPT-5.6 Luna,
 * Gemini 3.7 Flash, DeepSeek V4 Flash) recorded in kstack.json. Spawns
 * isolated child agents with those models to triage CI/check status and
 * review threads, generates fixes, commits, and pushes — stopping at
 * merge-ready. Never auto-merges, never re-stacks shared history.
 *
 * Command: /pr-autopilot [--mode check|threads|drive|watch|cleanup] [--pr <number>]
 * Config:  "pr-autopilot" section of $PI_CODING_AGENT_DIR/kstack.json (see README.md)
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { AutopilotLifecycle } from "./lifecycle.ts";
import { resolveModels, loadConfig, modelCliId } from "./config.ts";
import { parseArgs } from "./command.ts";
import { runAutopilot, type LifecyclePhase } from "./autopilot.ts";
import { isChildModelAvailable } from "../plan-implement/model-availability.ts";
import type { AutopilotMode, ExecFn, ExecFnResult } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");

/** Tiny models the autopilot is allowed to use — the exclusive child agent set. */
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

/** Exec wrapper forwarding the autopilot's per-call cwd/timeout to pi.exec. */
function makeExec(pi: ExtensionAPI): ExecFn {
	return (command, args, options) => pi.exec(command, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal }) as Promise<ExecFnResult>;
}

export default function prAutopilotExtension(pi: ExtensionAPI): void {
	const lifecycle = new AutopilotLifecycle();
	// Extensions normally load before session_start; eager activation also keeps
	// commands usable when an extension is loaded into an existing session.
	lifecycle.startSession();
	let abortController: AbortController | undefined;

	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => {
		abortController?.abort();
		abortController = undefined;
		lifecycle.shutdownSession();
	});

	pi.registerShortcut("ctrl+shift+b", {
		description: "Abort the running pr-autopilot child agent",
		handler: async (ctx) => {
			if (abortController && !abortController.signal.aborted) {
				abortController.abort();
				ctx.ui.setStatus("pr-autopilot", "pr-autopilot: aborting child agent…");
			} else {
				ctx.ui.notify("No pr-autopilot child agent is running.", "info");
			}
		},
	});

	pi.registerMessageRenderer("pr-autopilot", (message, { expanded, outputPad }, theme) => {
		const details = message.details as PhaseDetails | undefined;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		const icon = theme.fg("success", "▢");
		const header = `${icon} ${theme.fg("accent", "PR Autopilot")} ${theme.fg("muted", `— mode: ${details?.mode ?? "check"} — ${details?.status ?? "running"} — cycles: ${details?.cycles ?? 0}`)}`;
		if (!expanded) {
			box.addChild(new Text(`${header}${theme.fg("dim", " (Ctrl+O to expand)")}`, 0, 0));
			return box;
		}
		const lines = [
			`${icon} PR Autopilot — ${details?.mode ?? "check"}`,
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
			customType: "pr-autopilot",
			content,
			display: true,
			details,
		});
	}

	/** Core runner for an autopilot request that has crossed validation/naming. */
	async function runAutopilotCommand(
		mode: string,
		prNumber: number | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const notify = ctx.ui.notify.bind(ctx.ui);
		if (!ctx.hasUI) {
			notify("pr-autopilot requires interactive (TUI/RPC) mode.", "error");
			return;
		}
		if (lifecycle.isRunning()) {
			notify("A pr-autopilot run is already active. Press Ctrl+Shift+B to abort it.", "warning");
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
			`Run pr-autopilot (${mode} mode)?`,
			`PR: ${prNumber ? `#${prNumber}` : "lowest unmerged (auto-detected)"}\n` +
				`Models (tiny only):\n${modelsDisplay}\n\n` +
				`Timeout: ${config.timeoutMinutes} min idle / ${config.maxRuntimeMinutes} max per child agent\n` +
				"Bounded invariants:\n" +
				"- Works the lowest unmerged PR first\n" +
				"- Conflicts/behind: merge origin/<base> into the frontier (never rebase)\n" +
				"- Comments before CI; watch pending checks instead of inventing work\n" +
				"- Stops at merge-ready (never auto-merges)\n" +
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
			tempDir = mkdtempSync(join(tmpdir(), "pi-pr-autopilot-"));
			const triagerPromptFile = join(tempDir, "triager-prompt.md");
			const fixerPromptFile = join(tempDir, "fixer-prompt.md");
			writeFileSync(triagerPromptFile, readPrompt("triager.md"), { encoding: "utf8", mode: 0o600 });
			writeFileSync(fixerPromptFile, readPrompt("fixer.md"), { encoding: "utf8", mode: 0o600 });

			const updateStatus = (phase: LifecyclePhase, cycles = 0) => {
				if (lifecycle.isCurrent(runToken)) {
					ctx.ui.setStatus("pr-autopilot", `pr-autopilot: ${phase}`);
					sendPhaseMessage(pi, mode, phase, cycles, modelList, phase);
				}
			};

			const result = await runAutopilot(
				mode as AutopilotMode,
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
					setPhase: (phase, cycles) => updateStatus(phase, cycles),
					notify: notify,
					confirm: (label, body) => ctx.ui.confirm(label, body),
				},
				abort.signal,
			);

			if (lifecycle.isCurrent(runToken)) {
				ctx.ui.setStatus("pr-autopilot", undefined);
				if (result.status === "merge-ready") {
					notify(
						`PR autopilot complete — PR #${result.prState?.number ?? "?"} looks merge-ready. ` +
							"Stop at merge-ready; no merge performed. Use /session-archive to archive this session.",
						"info",
					);
					sendPhaseMessage(pi, mode, "idle", result.cyclesCompleted, modelList, "Looks merge-ready — stopped, not merged.");
				} else if (result.status === "cleaned") {
					notify("PR autopilot cleanup complete. Managed worktree removed; session archive is manual.", "info");
				} else if (result.status === "blocked") {
					notify(
						`PR autopilot blocked: ${result.blockedReasons.join("; ")}. ` +
							"These require human intervention. Run /pr-autopilot --mode check to reassess.",
						"error",
					);
				} else if (result.status === "aborted") {
					notify("PR autopilot aborted.", "info");
				} else {
					notify(`PR autopilot ended: ${result.status}. ${result.blockedReasons.join("; ") || ""}`, result.status === "failed" ? "error" : "warning");
				}
			}
		} finally {
			abortController = undefined;
			lifecycle.endRun(runToken);
			if (tempDir) {
				try {
					rmSync(tempDir, { recursive: true, force: true });
				} catch {
					notify(`pr-autopilot: could not remove temp dir ${tempDir}. Remove it manually.`, "warning");
				}
			}
			if (lifecycle.isCurrent(runToken)) ctx.ui.setStatus("pr-autopilot", undefined);
		}
	}

	pi.registerCommand("pr-autopilot", {
		description:
			"Keep an open PR merge-ready with tiny models only: /pr-autopilot [--mode check|threads|drive|watch|cleanup] [--pr <number>]. " +
			"Stops at merge-ready; never auto-merges or rebases shared history.",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const mode = parsed.args.mode;
			await runAutopilotCommand(mode, parsed.args.pr, ctx);
		},
	});

	// Listen for in-process API requests from the router or other extensions.
	pi.events.on(PRAUTOPILOT_REQUEST_EVENT, (data) => {
		claimRequest(data, (mode, prNumber, ctx) => runAutopilotCommand(mode, prNumber, ctx));
	});
}

// --- In-process API request contract ---

export const PRAUTOPILOT_REQUEST_EVENT = "kstack:pr-autopilot:request";

export interface PrAutopilotRequest {
	schemaVersion: 1;
	mode: string;
	prNumber: number | undefined;
	ctx: ExtensionCommandContext;
	claimed: boolean;
	completion?: Promise<void>;
}

export function isPrAutopilotRequest(value: unknown): value is PrAutopilotRequest {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Partial<PrAutopilotRequest>;
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
	if (!isPrAutopilotRequest(value) || value.claimed) return false;
	value.claimed = true;
	value.completion = run(value.mode, value.prNumber, value.ctx);
	return true;
}
