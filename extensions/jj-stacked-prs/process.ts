/** Hard-capped, abortable subprocess runner for jj/git/gh. */

import { spawn as nodeSpawn } from "node:child_process";
import { DIAGNOSTICS_CAP_BYTES, KILL_GRACE_MS, STDERR_CAP_BYTES, STDOUT_CAP_BYTES } from "./types.ts";

export interface SpawnedProcess {
	stdout: { on(event: "data", cb: (data: Buffer) => void): void };
	stderr: { on(event: "data", cb: (data: Buffer) => void): void };
	on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	on(event: "error", cb: (error: Error) => void): void;
	kill(signal?: NodeJS.Signals): boolean;
	pid?: number;
	killed?: boolean;
}

export type SpawnImpl = (
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; shell: false; stdio: ["ignore", "pipe", "pipe"] },
) => SpawnedProcess;

interface RunOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	stdoutCapBytes?: number;
	stderrCapBytes?: number;
	killGraceMs?: number;
	env?: NodeJS.ProcessEnv;
}

interface CommandSuccess {
	kind: "ok";
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandFailure =
	| { kind: "nonzero"; code: number; stdout: string; stderr: string; message: string }
	| { kind: "timeout"; message: string; stdout: string; stderr: string }
	| { kind: "cancelled"; message: string; stdout: string; stderr: string }
	| { kind: "overflow"; stream: "stdout" | "stderr"; message: string }
	| { kind: "spawn-failed"; message: string }
	| { kind: "uncertain"; message: string; stdout: string; stderr: string };

export type CommandResult = CommandSuccess | CommandFailure;
export type ProcessRunner = (argv: readonly string[], options: RunOptions) => Promise<CommandResult>;

export function createProcessRunner(spawnImpl: SpawnImpl = defaultSpawn): ProcessRunner {
	return (argv, options) => runCommand(argv, options, spawnImpl);
}

export async function runCommand(
	argv: readonly string[],
	options: RunOptions,
	spawnImpl: SpawnImpl = defaultSpawn,
): Promise<CommandResult> {
	if (argv.length === 0) return { kind: "spawn-failed", message: "No command was provided." };
	const [command, ...args] = argv;
	const stdoutCap = options.stdoutCapBytes ?? STDOUT_CAP_BYTES;
	const stderrCap = options.stderrCapBytes ?? STDERR_CAP_BYTES;
	const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

	let child: SpawnedProcess;
	try {
		child = spawnImpl(command, args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		return { kind: "spawn-failed", message: redact(`Spawn failed: ${errorMessage(error)}`) };
	}

	return await new Promise((resolve) => {
		const stdout = new CappedBuffer(stdoutCap);
		const stderr = new CappedBuffer(stderrCap);
		let settled = false;
		let timedOut = false;
		let cancelled = false;
		let overflow: "stdout" | "stderr" | undefined;
		let spawnError: string | undefined;
		let killStarted = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const stop = () => {
			if (killStarted) return;
			killStarted = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			graceTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, killGraceMs);
		};
		const onAbort = () => {
			cancelled = true;
			stop();
		};

		child.stdout.on("data", (chunk) => {
			if (!stdout.push(chunk) && !overflow) {
				overflow = "stdout";
				stop();
			}
		});
		child.stderr.on("data", (chunk) => {
			if (!stderr.push(chunk) && !overflow) {
				overflow = "stderr";
				stop();
			}
		});
		child.on("error", (error) => {
			spawnError = redact(`Spawn failed: ${errorMessage(error)}`);
			if (overflow) {
				return finish({
					kind: "overflow",
					stream: overflow,
					message: `Command output exceeded the ${overflow === "stdout" ? stdoutCap : stderrCap}-byte ${overflow} cap: ${command}`,
				});
			}
			if (cancelled) {
				return finish({
					kind: "cancelled",
					message: `Command cancelled: ${command}`,
					stdout: stdout.toString(),
					stderr: stderr.toString(),
				});
			}
			if (timedOut) {
				return finish({
					kind: "timeout",
					message: `Command timed out after ${options.timeoutMs}ms: ${command}`,
					stdout: stdout.toString(),
					stderr: stderr.toString(),
				});
			}
			finish({ kind: "spawn-failed", message: spawnError });
		});
		child.on("close", (code, signal) => {
			const out = stdout.toString();
			const err = stderr.toString();
			if (overflow) {
				return finish({
					kind: "overflow",
					stream: overflow,
					message: `Command output exceeded the ${overflow === "stdout" ? stdoutCap : stderrCap}-byte ${overflow} cap: ${command}`,
				});
			}
			if (spawnError) return finish({ kind: "spawn-failed", message: spawnError });
			if (cancelled) {
				return finish({
					kind: "cancelled",
					message: `Command cancelled: ${command}`,
					stdout: out,
					stderr: err,
				});
			}
			if (timedOut) {
				return finish({
					kind: "timeout",
					message: `Command timed out after ${options.timeoutMs}ms: ${command}`,
					stdout: out,
					stderr: err,
				});
			}
			if (code === null) {
				return finish({
					kind: "uncertain",
					message: `Command closed without an exit code${signal ? ` (${signal})` : ""}: ${command}`,
					stdout: out,
					stderr: err,
				});
			}
			if (code !== 0) {
				return finish({
					kind: "nonzero",
					code,
					stdout: out,
					stderr: err,
					message: redact(err.trim() || out.trim() || `exit ${code}`),
				});
			}
			finish({ kind: "ok", code, stdout: out, stderr: err });
		});

		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		if (options.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				stop();
			}, options.timeoutMs);
		}
	});
}

function redact(text: string): string {
	return text
		.replace(/(https?:\/\/)[^@\s]+@/gi, "$1***@")
		.replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "***")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "***")
		.slice(0, DIAGNOSTICS_CAP_BYTES);
}

function defaultSpawn(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; shell: false; stdio: ["ignore", "pipe", "pipe"] },
): SpawnedProcess {
	return nodeSpawn(command, args, options);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class CappedBuffer {
	private chunks: Buffer[] = [];
	private bytes = 0;
	private overflowed = false;
	private decoder = new TextDecoder("utf-8", { fatal: false });
	private readonly cap: number;

	constructor(cap: number) {
		this.cap = cap;
	}

	push(chunk: Buffer): boolean {
		if (this.overflowed) return false;
		if (this.bytes + chunk.length > this.cap) {
			this.overflowed = true;
			return false;
		}
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		return true;
	}

	toString(): string {
		return this.decoder.decode(Buffer.concat(this.chunks, this.bytes));
	}
}
