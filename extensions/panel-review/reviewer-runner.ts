/**
 * Reviewer subprocess lifecycle.
 *
 * Spawns `pi --mode json -p --no-session` with read-only tools, discovery
 * disabled, and no shell. Parses newline-delimited JSON exactly like Pi's
 * subagent example, bounding stderr and output while streaming. A child that
 * goes silent for the idle timeout is killed as stalled; a separate absolute
 * ceiling bounds total runtime. On abort: SIGTERM, a short grace period, then
 * SIGKILL of the process tree.
 *
 * All process-spawn seams are injected so unit tests never launch Pi.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { LIMITS, type ReviewerResult, type ReviewerSpec, type UsageSummary } from "./types.ts";

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
	/** Grace period between SIGTERM and SIGKILL on abort. */
	killGraceMs?: number;
	/**
	 * Idle limit per child: any stdout/stderr output resets the timer, so a
	 * slow-but-progressing child is not killed. A silent child is stalled.
	 */
	timeoutMs?: number;
	/** Absolute wall-clock ceiling per child, regardless of activity. */
	maxRuntimeMs?: number;
	outputCapBytes?: number;
	stderrCapBytes?: number;
}

/** Resolve how to launch pi itself (mirrors Pi's subagent example). */
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

/** CLI arguments for an isolated, read-only reviewer child process. */
export function buildChildArgs(opts: {
	model: string;
	promptFile: string;
	task: string;
	/** Disable AGENTS.md/CLAUDE.md injection (used when the changeset edits them). */
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
		"--tools", "read,grep,find,ls",
		"--model", opts.model,
		"--append-system-prompt", opts.promptFile,
		opts.task,
	];
}

function truncateHeadUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let out = buf.subarray(0, maxBytes).toString("utf8");
	while (Buffer.byteLength(out, "utf8") > maxBytes) out = out.slice(0, -1);
	return `${out}\n\n[Output truncated at ${maxBytes} bytes.]`;
}

/** Duration for error messages: exact ms below one second, rounded seconds above. */
export function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

interface ChildEvent {
	type: string;
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	message?: {
		role?: string;
		model?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: { type: string; text?: string }[];
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
}

/** Incremental newline-delimited JSON parser; chunk-boundary safe. */
export class JsonLineParser {
	private buffer = "";
	private readonly onEvent: (event: ChildEvent) => void;
	constructor(onEvent: (event: ChildEvent) => void) {
		this.onEvent = onEvent;
	}

	push(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.processLine(line);
	}

	flush(): void {
		if (this.buffer.trim()) this.processLine(this.buffer);
		this.buffer = "";
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		try {
			this.onEvent(JSON.parse(line) as ChildEvent);
		} catch {
			// Ignore malformed lines; child diagnostics surface via stderr.
		}
	}
}

/** Short human-readable summary of a tool call, e.g. `read review-scope.ts`. */
export function summarizeToolCall(toolName: string, args: Record<string, unknown> | undefined): string {
	const raw =
		(args?.path as string) ??
		(args?.filePath as string) ??
		(args?.pattern as string) ??
		(args?.command as string) ??
		Object.values(args ?? {}).find((v): v is string => typeof v === "string");
	if (!raw) return toolName;
	// Show the basename for paths; clamp anything long.
	const compact = raw.includes("/") ? (raw.split("/").filter(Boolean).pop() ?? raw) : raw;
	const clipped = compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
	return `${toolName} ${clipped}`;
}

function emptyUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export interface RunReviewerOptions {
	spec: ReviewerSpec;
	model: string; // CLI model id (may include :thinking)
	promptFile: string;
	task: string;
	cwd: string;
	/** Disable AGENTS.md/CLAUDE.md injection in the child. */
	noContextFiles?: boolean;
	signal?: AbortSignal;
	deps?: RunnerDeps;
	onProgress?: (info: { label: string; turns: number; activity?: string }) => void;
}

export function runReviewer(options: RunReviewerOptions): Promise<ReviewerResult> {
	const { spec, model, promptFile, task, cwd, signal } = options;
	const deps = options.deps ?? {};
	const spawnImpl = deps.spawnImpl ?? (nodeSpawn as unknown as SpawnImpl);
	const invocation = (deps.piInvocation ?? getPiInvocation)(
		buildChildArgs({ model, promptFile, task, noContextFiles: options.noContextFiles }),
	);
	const outputCap = deps.outputCapBytes ?? LIMITS.reviewerOutputBytes;
	const stderrCap = deps.stderrCapBytes ?? LIMITS.stderrBytes;
	const killGraceMs = deps.killGraceMs ?? 5000;
	const timeoutMs = deps.timeoutMs ?? LIMITS.reviewerTimeoutMs;
	const maxRuntimeMs = deps.maxRuntimeMs ?? LIMITS.reviewerMaxRuntimeMs;

	return new Promise<ReviewerResult>((resolve) => {
		let proc: SpawnedProcess;
		try {
			proc = spawnImpl(invocation.command, invocation.args, {
				cwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			resolve({ status: "failed", label: spec.label, model, error: `Spawn failed: ${(err as Error).message}` });
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
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;

		const parser = new JsonLineParser((event) => {
			if (event.type === "tool_execution_start" && event.toolName) {
				activity = summarizeToolCall(event.toolName, event.args);
				options.onProgress?.({ label: spec.label, turns: usage.turns, activity });
				return;
			}
			if (event.type === "tool_execution_end") {
				activity = "thinking";
				options.onProgress?.({ label: spec.label, turns: usage.turns, activity });
				return;
			}
			if (event.type !== "message_end" || !event.message) return;
			const msg = event.message;
			if (msg.role !== "assistant") return;
			usage.turns++;
			if (msg.usage) {
				usage.input += msg.usage.input || 0;
				usage.output += msg.usage.output || 0;
				usage.cacheRead += msg.usage.cacheRead || 0;
				usage.cacheWrite += msg.usage.cacheWrite || 0;
				usage.cost += msg.usage.cost?.total || 0;
			}
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) errorMessage = msg.errorMessage;
			for (const part of msg.content ?? []) {
				if (part.type === "text" && part.text) finalText = part.text;
			}
			options.onProgress?.({ label: spec.label, turns: usage.turns, activity });
		});

		// Idle timeout: any child output (stdout events or stderr) re-arms the
		// timer, so a slow-but-progressing child keeps running while a genuinely
		// stalled child is killed. Defined before stream handlers reference it.
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
			parser.push(data.toString("utf8"));
		});
		proc.stderr.on("data", (data: Buffer) => {
			armIdleTimer();
			if (Buffer.byteLength(stderr, "utf8") < stderrCap) {
				stderr = truncateHeadUtf8(stderr + data.toString("utf8"), stderrCap);
			}
		});

		const finish = (result: ReviewerResult) => {
			if (settled) return;
			settled = true;
			if (idleTimer) clearTimeout(idleTimer);
			clearTimeout(runtimeTimer);
			if (graceTimer) clearTimeout(graceTimer);
			signal?.removeEventListener("abort", killProc);
			resolve(result);
		};

		/** Partial progress attached to timeout failures for post-mortem diagnosis. */
		const timeoutDiagnostics = (): { usage: UsageSummary; activity?: string } => ({
			usage: { ...usage },
			...(activity ? { activity } : {}),
		});

		const killTree = (sig: "SIGTERM" | "SIGKILL") => {
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, sig);
				else proc.kill(sig);
			} catch {
				try {
					proc.kill(sig);
				} catch {
					/* already gone */
				}
			}
		};

		const escalate = () => {
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
		if (signal) {
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}

		// Arm the idle timer at spawn; it resets on every child output chunk.
		armIdleTimer();

		// Absolute ceiling: bounds total runtime no matter how chatty the child is.
		const runtimeTimer = setTimeout(() => {
			runtimeExceeded = true;
			killTree("SIGTERM");
			escalate();
		}, maxRuntimeMs);
		runtimeTimer.unref?.();

		proc.on("error", (err) => {
			finish({ status: "failed", label: spec.label, model, error: `Spawn failed: ${err.message}` });
		});

		proc.on("close", (code) => {
			closed = true;
			parser.flush();
			if (wasAborted) {
				finish({ status: "aborted", label: spec.label, model });
				return;
			}
			if (idleTimedOut) {
				finish({
					status: "failed",
					label: spec.label,
					model,
					error: `Timed out: child produced no output for ${formatDuration(timeoutMs)} (${usage.turns} turns completed${activity ? `, last: ${activity}` : ""})`,
					...timeoutDiagnostics(),
				});
				return;
			}
			if (runtimeExceeded) {
				finish({
					status: "failed",
					label: spec.label,
					model,
					error: `Timed out: exceeded max runtime of ${formatDuration(maxRuntimeMs)} (${usage.turns} turns completed${activity ? `, last: ${activity}` : ""})`,
					...timeoutDiagnostics(),
				});
				return;
			}
			const output = truncateHeadUtf8(finalText.trim(), outputCap);
			const exitCode = code ?? 1;
			if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted") {
				const detail =
					errorMessage ||
					stderr.trim() ||
					(stopReason ? `stop reason: ${stopReason}` : `exit code ${exitCode}`);
				finish({ status: "failed", label: spec.label, model, error: detail });
				return;
			}
			if (!output) {
				finish({ status: "failed", label: spec.label, model, error: "Reviewer produced no output." });
				return;
			}
			finish({ status: "completed", label: spec.label, model, output, usage });
		});
	});
}
