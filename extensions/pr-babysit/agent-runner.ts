/**
 * Isolated tiny-model child agent lifecycle for the pr-babysit extension.
 *
 * Spawns `pi --mode json -p --no-session` with the tiny models from kstack.json,
 * a role-specific system prompt, and a mode-0600 task file. Parses JSONL exactly
 * like plan-implement and panel-review, bounding stderr and output while
 * streaming progress. On abort: SIGTERM → grace → SIGKILL of the process group.
 *
 * Children never discover extensions or skills — the babysitter owns the
 * workflow entirely — and run with the tool set the babysitter grants per role.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { JsonLineParser } from "../shared/pi-json-lines.ts";
import { LIMITS, type BabysitAgentRole, type BabysitModelSpec, type ExecFnResult, type UsageSummary } from "./types.ts";

export interface SpawnedProcess {
	stdout: { on(event: "data", cb: (data: Buffer) => void): void };
	stderr: { on(event: "data", cb: (data: Buffer) => void): void };
	on(event: "close", cb: (code: number | null) => void): void;
	on(event: "error", cb: (err: Error) => void): void;
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
	maxRuntimeMs?: number;
	stderrCapBytes?: number;
	outputCapBytes?: number;
	stdoutLineCapBytes?: number;
}

/** Build the CLI argument list for a tiny-model babysit child agent. */
export function buildChildArgs(opts: {
	model: string;
	promptFile: string;
	taskFile: string;
	/** Tools to grant (e.g. "read,grep,find,ls,bash" or "read,grep,find,ls"). */
	tools?: string;
	/** Disable AGENTS.md/CLAUDE.md injection. */
	noContextFiles?: boolean;
}): string[] {
	return [
		"--mode", "json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		...(opts.noContextFiles ? ["--no-context-files"] : []),
		...(opts.tools ? ["--tools", opts.tools] : []),
		"--model", opts.model,
		"--append-system-prompt", opts.promptFile,
		`Read the task at ${opts.taskFile}.`,
	];
}

/** Resolve how to launch pi (mirrors Pi's subagent example). */
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

function truncateHeadUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let out = buf.subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[Output truncated at ${maxBytes} bytes.]`;
}

function assistantText(message: { content?: { type?: string; text?: string }[] } | undefined): string {
	let text = "";
	for (const part of message?.content ?? []) {
		if (part.type === "text" && part.text) text += part.text;
	}
	return text;
}

interface AgentRunResultBase {
	role: BabysitAgentRole;
	model: string;
	usage: UsageSummary;
}

export type AgentRunResult =
	| (AgentRunResultBase & { status: "completed"; output: string })
	| (AgentRunResultBase & { status: "failed"; error: string })
	| (AgentRunResultBase & { status: "aborted" });

function emptyUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** Short human-readable summary of a tool call. */
function summarizeToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
	const raw =
		(args?.path as string) ??
		(args?.filePath as string) ??
		(args?.pattern as string) ??
		(args?.command as string) ??
		Object.values(args ?? {}).find((v): v is string => typeof v === "string");
	if (!raw) return toolName;
	const compact = raw.includes("/") ? (raw.split("/").filter(Boolean).pop() ?? raw) : raw;
	const clipped = compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
	return `${toolName} ${clipped}`;
}

export interface RunAgentOptions {
	role: BabysitAgentRole;
	spec: BabysitModelSpec;
	promptFile: string;
	taskFile: string;
	cwd: string;
	tools?: string;
	signal?: AbortSignal;
	deps?: RunnerDeps;
	onProgress?: (info: { role: BabysitAgentRole; turns: number; activity?: string; preview?: string }) => void;
}

export function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
	const deps = options.deps ?? {};
	const spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
	const modelCliId = options.spec.thinking ? `${options.spec.model}:${options.spec.thinking}` : options.spec.model;
	const invocation = (deps.piInvocation ?? getPiInvocation)(
		buildChildArgs({
			model: modelCliId,
			promptFile: options.promptFile,
			taskFile: options.taskFile,
			tools: options.tools,
		}),
	);

	const outputCap = deps.outputCapBytes ?? LIMITS.outputBytes;
	const stderrCap = deps.stderrCapBytes ?? LIMITS.stderrBytes;
	const stdoutLineCap = deps.stdoutLineCapBytes ?? LIMITS.stdoutLineBytes;
	const killGraceMs = deps.killGraceMs ?? LIMITS.killGraceMs;
	const timeoutMs = deps.timeoutMs ?? LIMITS.defaultTimeoutMinutes * 60_000;
	const maxRuntimeMs = deps.maxRuntimeMs ?? LIMITS.defaultMaxRuntimeMinutes * 60_000;

	return new Promise<AgentRunResult>((resolve) => {
		let proc: SpawnedProcess;
		try {
			proc = spawnImpl(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ status: "failed", role: options.role, model: modelCliId, error: `Spawn failed: ${(error as Error).message}`, usage: emptyUsage() });
			return;
		}

		const usage = emptyUsage();
		let stderr = "";
		let finalText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let wasAborted = false;
		let idleTimedOut = false;
		let runtimeExceeded = false;
		let closed = false;
		let settled = false;
		let activity: string | undefined;
		let streamingPreview = "";
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;

		const emitProgress = () => {
			options.onProgress?.({
				role: options.role,
				turns: usage.turns,
				activity,
				...(streamingPreview ? { preview: streamingPreview } : {}),
			});
		};

		const setPreview = (text: string) => {
			streamingPreview = truncateHeadUtf8(text, 240).slice(-240);
		};

		const parser = new JsonLineParser((event) => {
			if (event.type === "tool_execution_start" && event.toolName) {
				activity = summarizeToolCall(event.toolName, event.args);
				emitProgress();
				return;
			}
			if (event.type === "tool_execution_end") {
				activity = "thinking";
				emitProgress();
				return;
			}
			if (event.type !== "message_end" || !event.message) return;
			const msg = event.message;
			if (msg.role !== "assistant") return;
			usage.turns++;
			usage.input += msg.usage?.input ?? 0;
			usage.output += msg.usage?.output ?? 0;
			usage.cacheRead += msg.usage?.cacheRead ?? 0;
			usage.cacheWrite += msg.usage?.cacheWrite ?? 0;
			usage.cost += msg.usage?.cost?.total ?? 0;
			stopReason = msg.stopReason ?? stopReason;
			errorMessage = msg.errorMessage ?? errorMessage;
			const authoritative = assistantText(msg);
			if (authoritative) {
				finalText = authoritative;
				setPreview(authoritative);
			}
			emitProgress();
		});

		const armIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				idleTimedOut = true;
				killTree("SIGTERM");
				escalate();
			}, timeoutMs);
			idleTimer.unref?.();
		};

		proc.stdout.on("data", (data: Buffer) => {
			armIdleTimer();
			parser.push(data);
		});
		proc.stderr.on("data", (data: Buffer) => {
			armIdleTimer();
			if (Buffer.byteLength(stderr, "utf8") < stderrCap) {
				stderr = truncateHeadUtf8(stderr + data.toString("utf8"), stderrCap);
			}
		});

		const killTree = (sig: "SIGTERM" | "SIGKILL") => {
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, sig);
				else proc.kill(sig);
			} catch {
				try {
					proc.kill(sig);
				} catch {
					// Process already exited.
				}
			}
		};

		const escalate = () => {
			if (graceTimer) return;
			graceTimer = setTimeout(() => {
				if (!closed) killTree("SIGKILL");
			}, killGraceMs);
			graceTimer.unref?.();
		};

		const killProc = () => {
			wasAborted = true;
			killTree("SIGTERM");
			escalate();
		};
		if (options.signal) {
			if (options.signal.aborted) killProc();
			else options.signal.addEventListener("abort", killProc, { once: true });
		}

		armIdleTimer();

		const runtimeTimer = setTimeout(() => {
			runtimeExceeded = true;
			killTree("SIGTERM");
			escalate();
		}, maxRuntimeMs);
		runtimeTimer.unref?.();

		proc.on("error", (err) => {
			resolve({ status: "failed", role: options.role, model: modelCliId, error: `Spawn failed: ${err.message}`, usage: emptyUsage() });
		});

		proc.on("close", (code) => {
			closed = true;
			parser.flush();
			if (wasAborted) {
				resolve({ status: "aborted", role: options.role, model: modelCliId, usage });
				return;
			}
			if (idleTimedOut) {
				resolve({
					status: "failed",
					role: options.role,
					model: modelCliId,
					error: `Timed out: child produced no output for ${Math.round(timeoutMs / 1000)}s (${usage.turns} turns).`,
					usage,
				});
				return;
			}
			if (runtimeExceeded) {
				resolve({
					status: "failed",
					role: options.role,
					model: modelCliId,
					error: `Timed out: exceeded max runtime of ${Math.round(maxRuntimeMs / 1000)}s.`,
					usage,
				});
				return;
			}
			const output = truncateHeadUtf8(finalText.trim(), outputCap);
			const exitCode = code ?? 1;
			if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted") {
				resolve({
					status: "failed",
					role: options.role,
					model: modelCliId,
					error: errorMessage || stderr.trim() || (stopReason ? `stop reason: ${stopReason}` : `exit code ${exitCode}`),
					usage,
				});
				return;
			}
			if (!output) {
				resolve({
					status: "failed",
					role: options.role,
					model: modelCliId,
					error: `Agent produced no output (${usage.turns} turns).`,
					usage,
				});
				return;
			}
			resolve({ status: "completed", role: options.role, model: modelCliId, output, usage });
		});
	});
}
