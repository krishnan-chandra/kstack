/** Thin classifier adapter around the shared child-agent lifecycle. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	childIsolationArgs,
	getPiInvocation,
	runChildAgent,
	type SpawnedProcess,
	type SpawnImpl,
} from "../shared/child-agent-runner.ts";
import { parseClassifierOutput } from "./classification.ts";
import { type ClassifierEnvelope, DEFAULTS } from "./types.ts";

export type { SpawnedProcess, SpawnImpl };
export { getPiInvocation };

const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), "prompts", "classifier.md");
const STDOUT_LINE_CAP_BYTES = 1024 * 1024;
const STDERR_CAP_BYTES = 4 * 1024;
const KILL_GRACE_MS = 5000;
interface ClassifierUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}
export type ClassifierRunResult =
	| { status: "completed"; envelope: ClassifierEnvelope; model: string; usage: ClassifierUsage }
	| { status: "failed"; error: string; stderr: string }
	| { status: "aborted" };
interface ClassifierRunnerOptions {
	model: string;
	task: string;
	thinking?: string;
	signal?: AbortSignal;
	timeoutSeconds?: number;
	stderrCapBytes?: number;
	promptFile?: string;
	killGraceMs?: number;
	spawnImpl?: SpawnImpl;
}
export function buildClassifierChildArgs(
	model: string,
	options: { promptFile?: string; thinking?: string } = {},
): string[] {
	return [
		...childIsolationArgs({ noContextFiles: true, noToolsNoApprove: true }),
		"--model",
		model,
		...(options.thinking ? ["--thinking", options.thinking] : []),
		"--append-system-prompt",
		options.promptFile ?? PROMPT_FILE,
	];
}
export async function runClassifier(options: ClassifierRunnerOptions): Promise<ClassifierRunResult> {
	const timeoutSeconds = options.timeoutSeconds ?? DEFAULTS.timeoutSeconds;
	const result = await runChildAgent({
		args: buildClassifierChildArgs(options.model, options),
		cwd: process.cwd(),
		stdin: options.task,
		signal: options.signal,
		deps: {
			spawnImpl: options.spawnImpl,
			maxRuntimeMs: timeoutSeconds * 1000,
			stderrCapBytes: options.stderrCapBytes ?? STDERR_CAP_BYTES,
			stdoutLineCapBytes: STDOUT_LINE_CAP_BYTES,
			killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
		},
	});
	if (result.status === "aborted") return { status: "aborted" };
	if (result.status === "failed") {
		let error = result.error;
		if (error.startsWith("Timed out: exceeded max runtime")) error = `Classifier timed out after ${timeoutSeconds}s.`;
		if (error.startsWith("Child emitted a JSONL")) error = error.replace("Child emitted", "Classifier emitted");
		if (error.startsWith("Child produced no output.")) error = "Classifier produced no assistant output.";
		if (/^exit code \d+$/.test(error)) error = `Classifier exited with ${error}.`;
		return { status: "failed", error, stderr: result.stderr };
	}
	const parsed = parseClassifierOutput(result.output);
	if (!parsed.ok) return { status: "failed", error: parsed.error, stderr: "" };
	return { status: "completed", envelope: parsed.envelope, model: options.model, usage: result.usage };
}
