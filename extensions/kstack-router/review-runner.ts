/** Review child for the kstack-router review route.
 *
 * The review leaves the session model unchanged and is instructed not to
 * mutate the repository. Inside Herdr it
 * runs in a pane split off the caller's own pane; everywhere else it runs as a
 * headless Pi child. Either way it enables normal extension discovery,
 * runs on a pinned frontier model, applies the thermo-nuclear lens
 * to a bounded diff of the current changeset, and posts the verdict back into
 * the session. The read-only contract lives in the prompt, not in a tool
 * allowlist.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { childIsolationArgs, runChildAgent, truncateHeadUtf8 } from "../shared/child-agent-runner.ts";
import { selectAdversaryTransport } from "../shared/herdr/adversary-runner.ts";
import { openPaneHost } from "../shared/herdr/agent-host.ts";
import { createNodeHerdrExec, type HerdrExec } from "../shared/herdr/herdr-cli.ts";
import type { ModelThinkingLevel } from "../shared/kstack-config.ts";
import { isChildModelAvailable } from "../shared/model-availability.ts";
import { modelCliId } from "../shared/model-spec.ts";
import { READ_ONLY_PROMPT_FILE, readPromptAsset } from "../shared/prompt-assets.ts";
import { loadConfig, resolveReviewModel } from "./config.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "playbooks");
const THERMO_SKILL_DIR = join(EXTENSION_DIR, "..", "..", "skills", "thermo-nuclear-code-quality-review");
const MAX_DIFF_BYTES = 128 * 1024;
const REVIEW_OUTPUT_CAP_BYTES = 64 * 1024;
const REVIEW_STDERR_CAP_BYTES = 8 * 1024;
const REVIEW_IDLE_TIMEOUT_MS = 5 * 60_000;
const REVIEW_MAX_RUNTIME_MS = 20 * 60_000;

interface ReviewChangeset {
	diff: string;
	truncated: boolean;
}

type ReviewRouteResult = { status: "dispatched" } | { status: "failed"; error: string } | { status: "aborted" };

type ReviewOutcome =
	| { status: "completed"; output: string; turns: number; cost: number }
	| { status: "failed"; error: string; turns: number; cost: number }
	| { status: "aborted"; turns: number; cost: number };

interface ReviewRunOptions {
	model: string;
	thinking?: ModelThinkingLevel;
	cwd: string;
	prompt: string;
	signal?: AbortSignal;
}

interface ReviewRouteDeps {
	loadConfig?: typeof loadConfig;
	runChild?: typeof runChildAgent;
	readAsset?: (dir: string, name: string) => string;
	selectTransport?: () => "pane" | "headless";
	openPane?: typeof openPaneHost;
	createExec?: () => HerdrExec;
}

interface ReviewMessageDetails {
	model?: string;
	turns?: number;
	cost?: number;
}

/** Register the verdict renderer for the review route. */
export function registerReviewRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("kstack-review", (message, { expanded, outputPad }, theme) => {
		const details =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ message.details as
				| ReviewMessageDetails
				| undefined;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const usage = details?.turns === undefined ? "" : ` — ${details.turns} turn(s), $${(details.cost ?? 0).toFixed(4)}`;
		const header = `${theme.fg("success", "■ Review")}${theme.fg("muted", ` — ${details?.model ?? "unknown model"}${usage}`)}`;
		box.addChild(
			new Text(
				expanded ? `${header}\n\n${message.content}` : `${header}${theme.fg("dim", " (Ctrl+O to expand)")}`,
				0,
				0,
			),
		);
		return box;
	});
}

/** Build the child args for one headless review. */
export function buildReviewArgs(model: string, thinking?: string): string[] {
	const args = [
		...childIsolationArgs({ noContextFiles: true, noExtensions: false }),
		"--skill",
		THERMO_SKILL_DIR,
		"--append-system-prompt",
		READ_ONLY_PROMPT_FILE,
		"--model",
		model,
	];
	if (thinking) args.push("--thinking", thinking);
	return args;
}

/** Unified diff of the current working-copy changes, capped for the child. */
export async function changesetDiff(pi: ExtensionAPI, cwd: string): Promise<ReviewChangeset> {
	const jj = await pi.exec("jj", ["workspace", "root"], { cwd, timeout: 10_000 }).catch(() => undefined);
	const command: [string, string[]] =
		jj && jj.code === 0 ? ["jj", ["diff", "--git"]] : ["git", ["diff", "--no-color", "--find-renames", "HEAD"]];
	const result = await pi.exec(command[0], command[1], { cwd, timeout: 30_000 }).catch(() => undefined);
	const raw = result && result.code === 0 ? result.stdout : "";
	if (Buffer.byteLength(raw, "utf8") <= MAX_DIFF_BYTES) return { diff: raw, truncated: false };
	return { diff: truncateHeadUtf8(raw, MAX_DIFF_BYTES, "Review diff"), truncated: true };
}

/** Compose the child prompt: the route playbook, the canonical lens, the task, and the changeset. */
export function buildReviewPrompt(options: {
	task: string;
	diff: string;
	truncated: boolean;
	readAsset?: (dir: string, name: string) => string;
}): string {
	const readAsset = options.readAsset ?? readPromptAsset;
	const scope = options.truncated
		? "The diff below is truncated; open the changed files directly for the remainder."
		: "Review the diff below and open any file it names.";
	return [
		readAsset(PLAYBOOKS_DIR, "review.md"),
		"",
		"## Canonical lens",
		"",
		readAsset(join(THERMO_SKILL_DIR, "references"), "thermo-nuclear.md"),
		"",
		"## Review task",
		"",
		options.task.trim() || "Review the current changeset.",
		"",
		"## Changeset",
		"",
		scope,
		"",
		"```diff",
		options.diff || "(no changes detected)",
		"```",
	].join("\n");
}

/** Run one headless review child. */
async function runHeadlessReview(options: ReviewRunOptions, runChild: typeof runChildAgent): Promise<ReviewOutcome> {
	const result = await runChild({
		args: buildReviewArgs(options.model, options.thinking),
		cwd: options.cwd,
		session: { owner: "kstack-router", label: "review" },
		stdin: options.prompt,
		signal: options.signal,
		deps: {
			idleTimeoutMs: REVIEW_IDLE_TIMEOUT_MS,
			maxRuntimeMs: REVIEW_MAX_RUNTIME_MS,
			outputCapBytes: REVIEW_OUTPUT_CAP_BYTES,
			stderrCapBytes: REVIEW_STDERR_CAP_BYTES,
		},
	});
	if (result.status === "completed") {
		return { status: "completed", output: result.output, turns: result.usage.turns, cost: result.usage.cost };
	}
	if (result.status === "aborted") {
		return { status: "aborted", turns: result.usage.turns, cost: result.usage.cost };
	}
	return {
		status: "failed",
		error: `The review child failed: ${result.error}`,
		turns: result.usage.turns,
		cost: result.usage.cost,
	};
}

/** Run one review in a Herdr pane split off the caller's own pane. */
async function runPaneReview(options: ReviewRunOptions, deps: ReviewRouteDeps): Promise<ReviewOutcome> {
	const openPane = deps.openPane ?? openPaneHost;
	const createExec = deps.createExec ?? (() => createNodeHerdrExec());
	const opened = await openPane(
		{ owner: "kstack-router", label: "review", cwd: options.cwd, maxAgents: 1 },
		{ exec: createExec() },
	);
	if (!opened.ok) return { status: "failed", error: opened.error, turns: 0, cost: 0 };
	try {
		const promptFile = join(opened.host.exchangeDir, "review-prompt.md");
		const outputFile = join(opened.host.exchangeDir, "review-verdict.md");
		await writeFile(promptFile, options.prompt, { mode: 0o600 });
		const started = await opened.host.start({
			role: "review",
			model: modelCliId({ model: options.model, thinking: options.thinking }),
			cwd: options.cwd,
			inheritExtensions: true,
			systemPromptFiles: [READ_ONLY_PROMPT_FILE],
			skillPaths: [THERMO_SKILL_DIR],
			noSkills: true,
			noContextFiles: true,
			sessionName: "kstack-router-review",
			signal: options.signal,
		});
		if (!started.ok) return { status: "failed", error: started.error, turns: 0, cost: 0 };
		const result = await started.agent.ask({
			promptFile,
			outputFile,
			timeoutMs: REVIEW_MAX_RUNTIME_MS,
			outputCapBytes: REVIEW_OUTPUT_CAP_BYTES,
			signal: options.signal,
		});
		if (result.status === "completed") {
			return { status: "completed", output: result.output, turns: result.usage.turns, cost: result.usage.cost };
		}
		if (result.status === "aborted") {
			return { status: "aborted", turns: result.usage.turns, cost: result.usage.cost };
		}
		if (result.status === "blocked") {
			return {
				status: "failed",
				error: `The review pane is blocked in ${result.paneId}.`,
				turns: result.usage.turns,
				cost: result.usage.cost,
			};
		}
		return { status: "failed", error: result.error, turns: result.usage.turns, cost: result.usage.cost };
	} finally {
		// Retains the split pane so the user can inspect the review.
		await opened.host.dispose();
	}
}

/** Post the review outcome back into the session. */
function postVerdict(pi: ExtensionAPI, model: string, outcome: ReviewOutcome): ReviewRouteResult {
	if (outcome.status === "completed") {
		pi.sendMessage({
			customType: "kstack-review",
			content: outcome.output,
			display: true,
			details: { model, turns: outcome.turns, cost: outcome.cost },
		});
		return { status: "dispatched" };
	}
	if (outcome.status === "aborted") {
		pi.sendMessage({
			customType: "kstack-review",
			content: "The review child was aborted.",
			display: true,
			details: { model, turns: outcome.turns, cost: outcome.cost },
		});
		return { status: "aborted" };
	}
	return { status: "failed", error: outcome.error };
}

/**
 * Run the review route: resolve the frontier model, run one review in a Herdr
 * pane when available or a headless child otherwise, and post the verdict back
 * into the session. The child uses normal tool discovery and receives the
 * shared read-only system prompt. The dispatch stays active until the review
 * finishes, so a second `/kstack` dispatch is rejected.
 */
export async function runReviewRoute(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	task: string,
	signal?: AbortSignal,
	deps: ReviewRouteDeps = {},
): Promise<ReviewRouteResult> {
	const load = deps.loadConfig ?? loadConfig;
	const configLoad = load();
	if (configLoad.status === "invalid") {
		return { status: "failed", error: `Invalid ${configLoad.path}: ${configLoad.error}` };
	}
	const config = configLoad.status === "loaded" ? configLoad.config : null;
	const selection = resolveReviewModel(config, {
		available: (provider, modelId) => isChildModelAvailable(ctx.modelRegistry, provider, modelId),
	});
	if ("error" in selection) return { status: "failed", error: selection.error };

	const changeset = await changesetDiff(pi, ctx.cwd);
	const prompt = buildReviewPrompt({ task, ...changeset, readAsset: deps.readAsset });
	const transport = (deps.selectTransport ?? selectAdversaryTransport)();
	pi.sendMessage({
		customType: "kstack-route",
		content:
			transport === "pane"
				? `Review started in a Herdr pane on ${selection.modelId}. The verdict appears here when it finishes.`
				: `Review started on ${selection.modelId} in a headless child. The verdict appears here when it finishes.`,
		display: true,
	});

	const options: ReviewRunOptions = {
		model: selection.modelId,
		thinking: selection.thinking,
		cwd: ctx.cwd,
		prompt,
		signal,
	};
	const outcome =
		transport === "pane"
			? await runPaneReview(options, deps)
			: await runHeadlessReview(options, deps.runChild ?? runChildAgent);
	return postVerdict(pi, selection.modelId, outcome);
}
