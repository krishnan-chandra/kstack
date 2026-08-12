/**
 * Isolated classifier subprocess runner.
 *
 * Pipes the task through stdin (never argv), disables all
 * tools/resources/context, parses the child's bounded JSONL event stream to
 * recover the assistant's final text and usage, and implements
 * timeout/abort/process-tree escalation.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonLineParser } from "../shared/pi-json-lines.ts";
import { DEFAULTS, type ClassifierEnvelope } from "./types.ts";
import { parseClassifierOutput } from "./classification.ts";

const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), "prompts", "classifier.md");

export interface SpawnedProcess {
	stdin?: { write: (data: string) => boolean; end: () => void };
	stdout: { on(event: "data", cb: (data: Buffer) => void): void };
	stderr: { on(event: "data", cb: (data: Buffer) => void): void };
	on(event: "close", cb: (code: number | null) => void): void;
	on(event: "error", cb: (error: Error) => void): void;
	kill(signal?: string): boolean;
	killed: boolean;
	pid?: number;
}

export type SpawnImpl = (command: string, args: string[], options: Record<string, unknown>) => SpawnedProcess;

export interface ClassifierUsage {
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

export interface ClassifierRunnerOptions {
	model: string;
	task: string;
	/** Optional thinking level passed to the classifier child (--thinking). */
	thinking?: string;
	signal?: AbortSignal;
	timeoutSeconds?: number;
	stderrCapBytes?: number;
	/** Classifier system-prompt file; defaults to prompts/classifier.md. */
	promptFile?: string;
	/** Grace period between SIGTERM and SIGKILL escalation. */
	killGraceMs?: number;
	spawnImpl?: SpawnImpl;
}

const STDOUT_TAIL_BYTES = 4 * 1024;
const STDOUT_LINE_CAP_BYTES = 1024 * 1024;
const STDERR_CAP_BYTES = 4 * 1024;
const KILL_GRACE_MS = 5000;

/**
 * Build the Pi child invocation args for the classifier. The task is never
 * placed in argv; it is piped over stdin by runClassifier.
 */
export function buildClassifierChildArgs(
	model: string,
	options: { promptFile?: string; thinking?: string } = {},
): string[] {
	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-tools",
		"--no-approve",
		"--model",
		model,
		...(options.thinking ? ["--thinking", options.thinking] : []),
		"--append-system-prompt",
		options.promptFile ?? PROMPT_FILE,
	];
}

/** Determine the pi invocation for spawning. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function processPlatformSupportsGroups(): boolean {
	return globalThis.process.platform !== "win32";
}

/**
 * Run the classifier as an isolated Pi child process.
 *
 * The task is piped through stdin and becomes the child's initial (and only)
 * user message. The child has no tools, no extensions, no skills, no prompt
 * templates, and no context files. With `--mode json` the child emits a
 * JSONL event stream on stdout; the final assistant text must contain the
 * sentinel-wrapped JSON envelope validated by parseClassifierOutput.
 */
export async function runClassifier(options: ClassifierRunnerOptions): Promise<ClassifierRunResult> {
	const model = options.model;
	const task = options.task;
	const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
	const timeoutSeconds = options.timeoutSeconds ?? DEFAULTS.timeoutSeconds;
	const stderrCap = options.stderrCapBytes ?? STDERR_CAP_BYTES;
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

	const args = buildClassifierChildArgs(model, { promptFile: options.promptFile, thinking: options.thinking });
	const invocation = getPiInvocation(args);

	return new Promise<ClassifierRunResult>((resolve) => {
		let process: SpawnedProcess;
		try {
			process = spawnImpl(invocation.command, invocation.args, {
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
				detached: processPlatformSupportsGroups(),
			});
		} catch (error) {
			resolve({ status: "failed", error: `Spawn failed: ${(error as Error).message}`, stderr: "" });
			return;
		}

		let stdoutTail = "";
		let stderr = "";
		let finalText = "";
		let modelError: string | undefined;
		let protocolError: string | undefined;
		let protocolKillStarted = false;
		let aborted = false;
		let timedOut = false;
		let closed = false;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const usage: ClassifierUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

		const parser = new JsonLineParser(
			(event) => {
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				const message = event.message;
				usage.turns++;
				usage.input += message.usage?.input ?? 0;
				usage.output += message.usage?.output ?? 0;
				usage.cacheRead += message.usage?.cacheRead ?? 0;
				usage.cacheWrite += message.usage?.cacheWrite ?? 0;
				usage.cost += message.usage?.cost?.total ?? 0;
				if (message.errorMessage) modelError = message.errorMessage;
				const text = (message.content ?? [])
					.filter((part) => part.type === "text" && part.text)
					.map((part) => part.text)
					.join("\n");
				if (text) finalText = text;
			},
			{
				maxLineBytes: STDOUT_LINE_CAP_BYTES,
				onOverflow: (maxBytes) => {
					protocolError = `Classifier emitted a JSONL stdout line larger than ${maxBytes} bytes.`;
				},
			},
		);

		const killTree = (signal: "SIGTERM" | "SIGKILL") => {
			try {
				if (processPlatformSupportsGroups() && process.pid) globalThis.process.kill(-process.pid, signal);
				else process.kill(signal);
			} catch {
				try {
					process.kill(signal);
				} catch {
					// Already exited.
				}
			}
		};

		const startEscalation = () => {
			if (graceTimer) return;
			graceTimer = setTimeout(() => {
				if (!closed) killTree("SIGKILL");
			}, killGraceMs);
			graceTimer.unref?.();
		};

		const abortProcess = () => {
			aborted = true;
			killTree("SIGTERM");
			startEscalation();
		};

		const finish = (result: ClassifierRunResult) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", abortProcess);
			resolve(result);
		};

		if (options.signal) {
			if (options.signal.aborted) abortProcess();
			else options.signal.addEventListener("abort", abortProcess, { once: true });
		}

		timeoutTimer = setTimeout(() => {
			timedOut = true;
			killTree("SIGTERM");
			startEscalation();
		}, timeoutSeconds * 1000);
		timeoutTimer.unref?.();

		// Pipe the task through stdin; it becomes the child's initial user
		// message in print mode. The task is never present in argv.
		if (process.stdin) {
			process.stdin.write(task);
			process.stdin.end();
		}

		process.stdout.on("data", (data: Buffer) => {
			const decoded = data.toString("utf8");
			parser.push(data);
			stdoutTail = (stdoutTail + decoded).slice(-STDOUT_TAIL_BYTES);
			if (protocolError && !protocolKillStarted) {
				protocolKillStarted = true;
				killTree("SIGTERM");
				startEscalation();
			}
		});

		process.stderr.on("data", (data: Buffer) => {
			const decoded = data.toString("utf8");
			if (Buffer.byteLength(stderr, "utf8") < stderrCap) {
				stderr += decoded;
				if (Buffer.byteLength(stderr, "utf8") > stderrCap) {
					stderr = stderr.slice(0, stderrCap) + "\n[stderr truncated]";
				}
			}
		});

		process.on("error", (error: Error) => {
			finish({ status: "failed", error: `Spawn error: ${error.message}`, stderr });
		});

		process.on("close", (code: number | null) => {
			closed = true;
			parser.flush();
			if (aborted) {
				finish({ status: "aborted" });
				return;
			}
			if (timedOut) {
				finish({ status: "failed", error: `Classifier timed out after ${timeoutSeconds}s.`, stderr });
				return;
			}
			if (protocolError) {
				finish({ status: "failed", error: protocolError, stderr });
				return;
			}
			if (modelError) {
				finish({ status: "failed", error: `Classifier model error: ${modelError}`, stderr });
				return;
			}
			if (code !== 0 && code !== null) {
				finish({ status: "failed", error: `Classifier exited with code ${code}.`, stderr });
				return;
			}
			if (!finalText.trim()) {
				finish({
					status: "failed",
					error: "Classifier produced no assistant output.",
					stderr: stderr || stdoutTail,
				});
				return;
			}

			// Parse the classifier envelope from the final assistant text.
			const result = parseClassifierOutput(finalText);
			if (!result.ok) {
				finish({ status: "failed", error: result.error, stderr: stderr || stdoutTail });
				return;
			}

			finish({ status: "completed", envelope: result.envelope, model, usage });
		});
	});
}
