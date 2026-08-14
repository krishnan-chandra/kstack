/** Shared lifecycle for isolated Pi child agents.
 *
 * Callers choose idle and/or absolute runtime limits. This lets legacy callers
 * preserve a total-only timeout while newer callers use both protections.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { JsonLineParser } from "./pi-json-lines.ts";

export interface SpawnedProcess {
	stdin?: { write(data: string): boolean; end(): void };
	stdout: { on(event: "data", cb: (data: Buffer) => void): void };
	stderr: { on(event: "data", cb: (data: Buffer) => void): void };
	on(event: "close", cb: (code: number | null) => void): void;
	on(event: "error", cb: (error: Error) => void): void;
	kill(signal?: string): boolean;
	killed: boolean;
	pid?: number;
}

export type SpawnImpl = (command: string, args: string[], options: Record<string, unknown>) => SpawnedProcess;

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface ChildRunnerDeps {
	spawnImpl?: SpawnImpl;
	piInvocation?: (args: string[]) => { command: string; args: string[] };
	killGraceMs?: number;
	idleTimeoutMs?: number;
	maxRuntimeMs?: number;
	outputCapBytes?: number;
	stderrCapBytes?: number;
	stdoutLineCapBytes?: number;
}

export type ChildEvent =
	| { kind: "tool_start"; summary: string; at: number }
	| { kind: "tool_end"; durationMs?: number; at: number }
	| { kind: "text_delta"; delta: string; at: number }
	| { kind: "turn_end"; turn: number; text: string; usage: ChildUsage; at: number };

export interface RunChildOptions {
	args: string[];
	cwd: string;
	stdin?: string;
	signal?: AbortSignal;
	deps?: ChildRunnerDeps;
	onProgress?: (progress: { turns: number; activity?: string; preview?: string }) => void;
	onEvent?: (event: ChildEvent) => void;
}

export type ChildRunResult =
	| { status: "completed"; output: string; usage: ChildUsage }
	| { status: "failed"; error: string; usage: ChildUsage; stderr: string; activity?: string }
	| { status: "aborted"; usage: ChildUsage; activity?: string };

const DEFAULT_OUTPUT_CAP = 1024 * 1024;
const DEFAULT_STDERR_CAP = 64 * 1024;
const DEFAULT_LINE_CAP = 2 * 1024 * 1024;
const DEFAULT_KILL_GRACE = 5000;
const PREVIEW_CAP = 4096;

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

export function truncateHeadUtf8(text: string, maxBytes: number, label = "Output"): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let content = bytes.subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(content, "utf8") > maxBytes) content = content.slice(0, -1);
	return `${content}\n\n[${label} truncated at ${maxBytes} bytes.]`;
}

export function truncateTailUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	let output = bytes.subarray(start).toString("utf8");
	while (output && Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(1);
	return output;
}

export function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

export function summarizeToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
	const raw = (args?.path as string) ?? (args?.filePath as string) ?? (args?.pattern as string) ??
		(args?.command as string) ?? Object.values(args ?? {}).find((value): value is string => typeof value === "string");
	if (!raw) return toolName;
	const compact = raw.includes("/") ? (raw.split("/").filter(Boolean).pop() ?? raw) : raw;
	return `${toolName} ${compact.length > 48 ? `${compact.slice(0, 47)}…` : compact}`;
}

function emptyUsage(): ChildUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function assistantText(message: { content?: { type?: string; text?: string }[] } | undefined): string {
	return (message?.content ?? []).filter((part) => part.type === "text" && part.text).map((part) => part.text).join("");
}

export function runChildAgent(options: RunChildOptions): Promise<ChildRunResult> {
	const deps = options.deps ?? {};
	const spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
	const invocation = (deps.piInvocation ?? getPiInvocation)(options.args);
	const outputCap = deps.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
	const stderrCap = deps.stderrCapBytes ?? DEFAULT_STDERR_CAP;
	const lineCap = deps.stdoutLineCapBytes ?? DEFAULT_LINE_CAP;
	const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE;

	return new Promise((resolve) => {
		const usage = emptyUsage();
		let child: SpawnedProcess;
		try {
			child = spawnImpl(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ status: "failed", error: `Spawn failed: ${(error as Error).message}`, usage, stderr: "" });
			return;
		}

		let stderr = "";
		let finalText = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let activity: string | undefined;
		let preview = "";
		let protocolError: string | undefined;
		let aborting = false;
		let idleTimedOut = false;
		let runtimeTimedOut = false;
		let closed = false;
		let settled = false;
		let killStarted = false;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let lastToolStartAt: number | undefined;

		const emit = () => options.onProgress?.({ turns: usage.turns, activity, ...(preview ? { preview } : {}) });
		const killTree = (signal: "SIGTERM" | "SIGKILL") => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				try { child.kill(signal); } catch { /* already exited */ }
			}
		};
		const escalate = () => {
			if (graceTimer) return;
			graceTimer = setTimeout(() => { if (!closed) killTree("SIGKILL"); }, killGraceMs);
			graceTimer.unref?.();
		};
		const stop = () => {
			if (killStarted) return;
			killStarted = true;
			killTree("SIGTERM");
			escalate();
		};
		const abort = () => { aborting = true; stop(); };
		const finish = (result: ChildRunResult) => {
			if (settled) return;
			settled = true;
			if (idleTimer) clearTimeout(idleTimer);
			if (runtimeTimer) clearTimeout(runtimeTimer);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const armIdle = () => {
			if (deps.idleTimeoutMs === undefined) return;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => { idleTimedOut = true; stop(); }, deps.idleTimeoutMs);
			idleTimer.unref?.();
		};

		const parser = new JsonLineParser((event) => {
			if (event.type === "message_start" && event.message?.role === "assistant") { preview = ""; emit(); return; }
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if (delta?.type === "text_delta" && delta.delta) {
					preview = truncateTailUtf8(preview + delta.delta, PREVIEW_CAP);
					emit();
					options.onEvent?.({ kind: "text_delta", delta: delta.delta, at: Date.now() });
				}
				return;
			}
			if (event.type === "tool_execution_start" && event.toolName) {
				activity = summarizeToolCall(event.toolName, event.args);
				emit();
				if (lastToolStartAt !== undefined) {
					options.onEvent?.({ kind: "tool_end", at: Date.now() });
				}
				lastToolStartAt = Date.now();
				options.onEvent?.({ kind: "tool_start", summary: activity, at: lastToolStartAt });
				return;
			}
			if (event.type === "tool_execution_end") {
				activity = "thinking";
				emit();
				const now = Date.now();
				const durationMs = lastToolStartAt !== undefined ? Math.max(0, now - lastToolStartAt) : undefined;
				lastToolStartAt = undefined;
				options.onEvent?.({ kind: "tool_end", durationMs, at: now });
				return;
			}
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			const message = event.message;
			usage.turns++;
			const turnUsage: ChildUsage = {
				input: message.usage?.input ?? 0,
				output: message.usage?.output ?? 0,
				cacheRead: message.usage?.cacheRead ?? 0,
				cacheWrite: message.usage?.cacheWrite ?? 0,
				cost: message.usage?.cost?.total ?? 0,
				turns: 1,
			};
			usage.input += turnUsage.input;
			usage.output += turnUsage.output;
			usage.cacheRead += turnUsage.cacheRead;
			usage.cacheWrite += turnUsage.cacheWrite;
			usage.cost += turnUsage.cost;
			stopReason = message.stopReason ?? stopReason;
			errorMessage = message.errorMessage ?? errorMessage;
			const text = assistantText(message);
			if (text) { finalText = text; preview = truncateTailUtf8(text, PREVIEW_CAP); }
			emit();
			options.onEvent?.({ kind: "turn_end", turn: usage.turns, text, usage: turnUsage, at: Date.now() });
		}, { maxLineBytes: lineCap, onOverflow: (maxBytes) => { protocolError = `Child emitted a JSONL stdout line larger than ${maxBytes} bytes.`; } });

		child.stdout.on("data", (data) => { armIdle(); parser.push(data); if (protocolError) stop(); });
		child.stderr.on("data", (data) => { armIdle(); if (Buffer.byteLength(stderr, "utf8") < stderrCap) stderr = truncateHeadUtf8(stderr + data.toString("utf8"), stderrCap, "stderr"); });
		child.on("error", (error) => finish({ status: "failed", error: `Spawn failed: ${error.message}`, usage, stderr }));
		child.on("close", (code) => {
			closed = true;
			parser.flush();
			if (aborting) return finish({ status: "aborted", usage, activity });
			if (idleTimedOut) return finish({ status: "failed", error: `Timed out: child produced no output for ${formatDuration(deps.idleTimeoutMs!)} (${usage.turns} turns completed${activity ? `, last: ${activity}` : ""})`, usage, stderr, activity });
			if (runtimeTimedOut) return finish({ status: "failed", error: `Timed out: exceeded max runtime of ${formatDuration(deps.maxRuntimeMs!)} (${usage.turns} turns completed${activity ? `, last: ${activity}` : ""})`, usage, stderr, activity });
			if (protocolError) return finish({ status: "failed", error: protocolError, usage, stderr });
			const exitCode = code ?? 1;
			if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted" || errorMessage) {
				return finish({ status: "failed", error: errorMessage || stderr.trim() || (stopReason ? `stop reason: ${stopReason}` : `exit code ${exitCode}`), usage, stderr });
			}
			const output = truncateHeadUtf8(finalText.trim(), outputCap);
			if (!output) return finish({ status: "failed", error: `Child produced no output. (${usage.turns} turns completed${activity ? `, last: ${activity}` : ""})`, usage, stderr });
			finish({ status: "completed", output, usage });
		});

		if (options.signal) options.signal.aborted ? abort() : options.signal.addEventListener("abort", abort, { once: true });
		armIdle();
		if (deps.maxRuntimeMs !== undefined) {
			runtimeTimer = setTimeout(() => { runtimeTimedOut = true; stop(); }, deps.maxRuntimeMs);
			runtimeTimer.unref?.();
		}
		if (options.stdin !== undefined && child.stdin) { child.stdin.write(options.stdin); child.stdin.end(); }
	});
}
