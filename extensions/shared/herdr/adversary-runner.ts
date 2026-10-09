/** Adversary transport: a visible split pane inside Herdr, or a headless Pi child.
 *
 * The adversarial-implementation review loop uses this seam to decide where an
 * adversary lives. Inside Herdr it is a pane split off the caller's own pane
 * (see `openPaneHost`); everywhere else it is a non-interactive `pi` child.
 */

import {
	type ChildRunnerDeps,
	type ChildSession,
	type ChildUsage,
	childIsolationArgs,
	runChildAgent,
} from "../child-agent-runner.ts";
import { READ_ONLY_PROMPT_FILE } from "../prompt-assets.ts";

/* exported: adversary transport contract */
export type AdversaryTransport = "pane" | "headless";

/** Herdr is available exactly when the session advertises `HERDR_ENV=1`. */
export function selectAdversaryTransport(env: NodeJS.ProcessEnv = process.env): AdversaryTransport {
	return env.HERDR_ENV === "1" ? "pane" : "headless";
}

/* exported: headless adversary transport contract */
export interface HeadlessAdversaryOptions {
	/** Pi model reference in provider/model[:thinking] form. */
	model: string;
	cwd: string;
	/** Review request delivered on stdin. */
	prompt: string;
	/** Absolute path to the adversary system prompt. */
	systemPromptFile: string;
	/** Extra system prompt files appended after the adversary prompt. */
	extraSystemPromptFiles?: readonly string[];
	owner: string;
	label: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/* exported: headless adversary transport contract */
export type HeadlessAdversaryResult = (
	| { status: "completed"; output: string; session: ChildSession; usage: ChildUsage }
	| { status: "failed"; error: string; session: ChildSession; usage: ChildUsage }
	| { status: "aborted"; session: ChildSession; usage: ChildUsage }
) & { cleanupError?: string };

/** Build headless adversary argv with normal discovery and no tool allowlist. */
export function headlessAdversaryArgs(
	options: Pick<HeadlessAdversaryOptions, "model" | "systemPromptFile" | "extraSystemPromptFiles">,
): string[] {
	const args = [
		...childIsolationArgs({ noContextFiles: true, noExtensions: false }),
		"--model",
		options.model,
		"--append-system-prompt",
		options.systemPromptFile,
	];
	for (const file of options.extraSystemPromptFiles ?? []) args.push("--append-system-prompt", file);
	args.push("--append-system-prompt", READ_ONLY_PROMPT_FILE);
	return args;
}

/** Run one adversary as a non-interactive Pi child when Herdr is unavailable. */
export async function runHeadlessAdversary(
	options: HeadlessAdversaryOptions,
	deps: ChildRunnerDeps = {},
): Promise<HeadlessAdversaryResult> {
	const result = await runChildAgent({
		args: headlessAdversaryArgs(options),
		cwd: options.cwd,
		session: { owner: options.owner, label: options.label },
		stdin: options.prompt,
		signal: options.signal,
		deps: { ...deps, maxRuntimeMs: deps.maxRuntimeMs ?? options.timeoutMs },
	});
	const cleanup = result.cleanupError ? { cleanupError: result.cleanupError } : undefined;
	if (result.status === "completed")
		return { status: "completed", output: result.output, session: result.session, usage: result.usage, ...cleanup };
	if (result.status === "aborted")
		return { status: "aborted", session: result.session, usage: result.usage, ...cleanup };
	return { status: "failed", error: result.error, session: result.session, usage: result.usage, ...cleanup };
}
