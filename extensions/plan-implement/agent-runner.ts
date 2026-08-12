/** Isolated planner/implementer Pi subprocess lifecycle. */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { JsonLineParser } from "../shared/pi-json-lines.ts";
import { LIMITS, type AgentRunResult, type DeliveryMode, type UsageSummary } from "./types.ts";

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

export interface RunnerDeps {
	spawnImpl?: SpawnImpl;
	piInvocation?: (args: string[]) => { command: string; args: string[] };
	killGraceMs?: number;
	timeoutMs?: number;
	outputCapBytes?: number;
	stderrCapBytes?: number;
	stdoutLineCapBytes?: number;
}

export interface BuildChildArgsOptions {
	role: "planner" | "implementer";
	model: string;
	promptFile: string;
	taskFile: string;
	planFile?: string;
	/** Delivery mode; defaults to "single" (current behavior). */
	mode?: DeliveryMode;
	/** Stack mode only: skill paths re-added after --no-skills (Arena excluded). */
	skillPaths?: readonly string[];
}

/**
 * Skills and context files deliberately remain enabled in single-PR mode for
 * workflow composition. In stack mode, Arena is deterministically excluded by
 * disabling skill discovery (`--no-skills`) and re-adding every other skill
 * with repeated `--skill`; this prevents parallel candidates from corrupting a
 * shared jj operation log while preserving task-specific skills.
 */
export function buildChildArgs(options: BuildChildArgsOptions): string[] {
	const mode: DeliveryMode = options.mode ?? "single";
	const stackMode = mode === "stack";
	const skillFlags = stackMode ? expandSkillPaths(options.skillPaths) : [];

	let target: string;
	if (options.role === "planner") {
		const delivery = stackMode
			? 'This is a stacked-PR delivery. Begin the plan with a line reading exactly "Delivery: stacked-prs", then a line "Stack base: trunk()", then ordered PR slices.'
			: 'This is a single-PR delivery. Begin the plan with a line reading exactly "Delivery: single-pr".';
		target = `Read the user task at ${options.taskFile}, inspect the repository, and produce the plan. ${delivery}`;
	} else {
		const stackNote = stackMode ? " This is a stacked-PR delivery; consult the jj-stacked-prs skill and follow its local-stack policy." : "";
		target = `Read the user task at ${options.taskFile} and the approved plan at ${options.planFile}, then implement and verify it.${stackNote}`;
	}

	return [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-prompt-templates",
		...(stackMode ? ["--no-skills", ...skillFlags] : []),
		...(options.role === "planner" ? ["--tools", "read,grep,find,ls"] : []),
		"--model",
		options.model,
		"--append-system-prompt",
		options.promptFile,
		target,
	];
}

function expandSkillPaths(paths: readonly string[] | undefined): string[] {
	const flags: string[] = [];
	for (const path of paths ?? []) {
		if (path) flags.push("--skill", path);
	}
	return flags;
}

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

export function truncateUtf8(text: string, maxBytes: number, label = "Output"): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let content = bytes.subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(content, "utf8") > maxBytes) content = content.slice(0, -1);
	return `${content}\n\n[${label} truncated at ${maxBytes} bytes.]`;
}

function emptyUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function summarizeTool(toolName: string, args: Record<string, unknown> | undefined): string {
	const value = Object.values(args ?? {}).find((entry): entry is string => typeof entry === "string");
	if (!value) return toolName;
	const compact = value.length > 48 ? `${value.slice(0, 47)}…` : value;
	return `${toolName} ${compact}`;
}

export interface RunAgentOptions extends BuildChildArgsOptions {
	cwd: string;
	signal?: AbortSignal;
	deps?: RunnerDeps;
	onProgress?: (progress: { role: "planner" | "implementer"; turns: number; activity: string }) => void;
}

export function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
	const deps = options.deps ?? {};
	const spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
	const invocation = (deps.piInvocation ?? getPiInvocation)(buildChildArgs(options));
	const outputCap =
		deps.outputCapBytes ??
		(options.role === "planner" ? LIMITS.plannerOutputBytes : LIMITS.implementerOutputBytes);
	const stderrCap = deps.stderrCapBytes ?? LIMITS.stderrBytes;
	const stdoutLineCap = deps.stdoutLineCapBytes ?? LIMITS.stdoutLineBytes;
	const timeoutMs = deps.timeoutMs ?? LIMITS.defaultTimeoutMinutes * 60_000;
	const killGraceMs = deps.killGraceMs ?? LIMITS.killGraceMs;

	return new Promise<AgentRunResult>((resolve) => {
		let process: SpawnedProcess;
		try {
			process = spawnImpl(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				detached: processPlatformSupportsGroups(),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ status: "failed", role: options.role, model: options.model, error: `Spawn failed: ${(error as Error).message}` });
			return;
		}

		const usage = emptyUsage();
		let finalText = "";
		let stderr = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let aborted = false;
		let timedOut = false;
		let protocolError: string | undefined;
		let protocolKillStarted = false;
		let closed = false;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;

		const parser = new JsonLineParser((event) => {
			if (event.type === "tool_execution_start" && event.toolName) {
				options.onProgress?.({ role: options.role, turns: usage.turns, activity: summarizeTool(event.toolName, event.args) });
				return;
			}
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			const message = event.message;
			usage.turns++;
			usage.input += message.usage?.input ?? 0;
			usage.output += message.usage?.output ?? 0;
			usage.cacheRead += message.usage?.cacheRead ?? 0;
			usage.cacheWrite += message.usage?.cacheWrite ?? 0;
			usage.cost += message.usage?.cost?.total ?? 0;
			stopReason = message.stopReason ?? stopReason;
			errorMessage = message.errorMessage ?? errorMessage;
			const text = (message.content ?? [])
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text)
				.join("\n");
			if (text) finalText = text;
			options.onProgress?.({ role: options.role, turns: usage.turns, activity: "thinking" });
		}, {
			maxLineBytes: stdoutLineCap,
			onOverflow: (maxBytes) => {
				protocolError = `Child emitted a JSONL stdout line larger than ${maxBytes} bytes.`;
			},
		});

		process.stdout.on("data", (data) => {
			parser.push(data);
			if (protocolError && !protocolKillStarted) {
				protocolKillStarted = true;
				killTree("SIGTERM");
				startEscalation();
			}
		});
		process.stderr.on("data", (data) => {
			if (Buffer.byteLength(stderr, "utf8") < stderrCap) {
				stderr = truncateUtf8(stderr + data.toString("utf8"), stderrCap, "stderr");
			}
		});

		const killTree = (signal: "SIGTERM" | "SIGKILL") => {
			try {
				if (processPlatformSupportsGroups() && process.pid) globalThis.process.kill(-process.pid, signal);
				else process.kill(signal);
			} catch {
				try {
					process.kill(signal);
				} catch {
					// Process already exited.
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

		const finish = (result: AgentRunResult) => {
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
		}, timeoutMs);
		timeoutTimer.unref?.();

		process.on("error", (error) => {
			finish({ status: "failed", role: options.role, model: options.model, error: `Spawn failed: ${error.message}` });
		});

		process.on("close", (code) => {
			closed = true;
			parser.flush();
			if (aborted) {
				finish({ status: "aborted", role: options.role, model: options.model });
				return;
			}
			if (timedOut) {
				finish({ status: "failed", role: options.role, model: options.model, error: `Timed out after ${Math.round(timeoutMs / 1000)}s.` });
				return;
			}
			if (protocolError) {
				finish({ status: "failed", role: options.role, model: options.model, error: protocolError });
				return;
			}
			if ((code ?? 1) !== 0 || stopReason === "error" || stopReason === "aborted") {
				finish({
					status: "failed",
					role: options.role,
					model: options.model,
					error: errorMessage || stderr.trim() || (stopReason ? `stop reason: ${stopReason}` : `exit code ${code ?? 1}`),
				});
				return;
			}
			const output = truncateUtf8(finalText.trim(), outputCap);
			if (!output) {
				finish({ status: "failed", role: options.role, model: options.model, error: `${options.role} produced no final output.` });
				return;
			}
			finish({ status: "completed", role: options.role, model: options.model, output, usage });
		});
	});
}

function processPlatformSupportsGroups(): boolean {
	return globalThis.process.platform !== "win32";
}
