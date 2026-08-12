/**
 * Isolated classifier subprocess runner.
 *
 * Pipes the task through stdin, disables all tools/resources/context,
 * parses bounded Pi JSONL output, accumulates usage data, and implements
 * timeout/abort/process-tree escalation.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { DEFAULTS, CLASSIFIER_SENTINEL_START, CLASSIFIER_SENTINEL_END, type ClassifierEnvelope } from "./types.ts";
import { parseClassifierOutput } from "./classification.ts";

export interface SpawnedProcess {
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
	signal?: AbortSignal;
	timeoutSeconds?: number;
	stderrCapBytes?: number;
	spawnImpl?: SpawnImpl;
}

const STDOUT_CAP_BYTES = 16 * 1024;
const STDERR_CAP_BYTES = 4 * 1024;
const KILL_GRACE_MS = 5000;

/** Build the Pi child invocation args for the classifier. */
export function buildClassifierChildArgs(model: string): string[] {
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
		"--append-system-prompt",
		"stdin",
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
 * The task is piped through stdin. The child has no tools, no extensions,
 * no skills, no prompt templates, and no context files. The output must be
 * a JSON envelope wrapped in sentinel markers.
 */
export async function runClassifier(options: ClassifierRunnerOptions): Promise<ClassifierRunResult> {
	const model = options.model;
	const task = options.task;
	const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
	const timeoutSeconds = options.timeoutSeconds ?? DEFAULTS.timeoutSeconds;
	const stderrCap = options.stderrCapBytes ?? STDERR_CAP_BYTES;

	const args = buildClassifierChildArgs(model);
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

		let stdout = "";
		let stderr = "";
		let aborted = false;
		let timedOut = false;
		let closed = false;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const usage: ClassifierUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

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
			}, KILL_GRACE_MS);
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

		// Write the task to stdin and close it.
		const stdin = process as unknown as { stdin?: { write: (data: string) => boolean; end: () => void } };
		if (stdin.stdin) {
			// The classifier prompt is piped via the --append-system-prompt "stdin" approach.
			// The stdin content is the system prompt for classification.
			const prompt = buildClassifierPrompt(task);
			stdin.stdin.write(prompt);
			stdin.stdin.end();
		}

		process.stdout.on("data", (data: Buffer) => {
			if (Buffer.byteLength(stdout, "utf8") < STDOUT_CAP_BYTES) {
				const decoded = data.toString("utf8");
				// Track usage from JSONL events.
				try {
					const line = decoded.trim();
					if (line.startsWith("{")) {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message?.usage) {
							const u = event.message.usage;
							usage.turns++;
							usage.input += u.input ?? 0;
							usage.output += u.output ?? 0;
							usage.cacheRead += u.cacheRead ?? 0;
							usage.cacheWrite += u.cacheWrite ?? 0;
							usage.cost += u.cost?.total ?? 0;
						}
					}
				} catch {
					// Ignore parse errors in JSONL lines.
				}
				stdout += decoded;
				if (Buffer.byteLength(stdout, "utf8") > STDOUT_CAP_BYTES) {
					stdout = stdout.slice(0, STDOUT_CAP_BYTES);
				}
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
			if (aborted) {
				finish({ status: "aborted" });
				return;
			}
			if (timedOut) {
				finish({ status: "failed", error: `Classifier timed out after ${timeoutSeconds}s.`, stderr });
				return;
			}
			if (code !== 0 && code !== null) {
				finish({ status: "failed", error: `Classifier exited with code ${code}.`, stderr });
				return;
			}

			// Parse the classifier envelope from stdout.
			const result = parseClassifierOutput(stdout);
			if (!result.ok) {
				finish({ status: "failed", error: result.error, stderr });
				return;
			}

			finish({ status: "completed", envelope: result.envelope, model, usage });
		});
	});
}

/**
 * Build the classifier system prompt. The task is incorporated into the prompt
 * that is passed via stdin.
 */
function buildClassifierPrompt(task: string): string {
	return [
		`You are a routing classifier for the Kstack development assistant.`,
		`Classify the following user task into exactly one route.`,
		``,
		`Available routes:`,
		`- investigate: Explain, diagnose, research, or understand without requesting a fix. Read-only.`,
		`- change: Features, fixes, refactors, prototypes, docs/config changes, Pi extensions. Requires plan → approve → implement → review.`,
		`- arena: Spawn N parallel candidates at the same task, cross-judge, graft the best. Requires framing first.`,
		`- swarm: Fan out parallel workers across independent slices, aggregate results. Requires framing first.`,
		`- skill-authoring: Create, improve, debug, or evaluate a skill. Requires framing first.`,
		`- session-pickup: Continue linked or archived work, recover prior decisions. Read-only.`,
		`- review: Review existing working-tree or branch changes. Uses read-only panel review.`,
		`- unsupported: Persistent loops, auto-deployment, destructive ops, or unclear requests.`,
		``,
		`For "change" tasks, you may optionally recommend a delivery mode: "single" or "stack".`,
		`Ambiguous "figure it out" requests default to "investigate".`,
		`Only return the JSON envelope between the sentinel markers.`,
		``,
		`User task:`,
		task,
		``,
		`Respond with:`,
		CLASSIFIER_SENTINEL_START,
		`{"schemaVersion":1,"route":"...","confidence":"high|medium|low","rationale":"..."}`,
		CLASSIFIER_SENTINEL_END,
	].join("\n");
}