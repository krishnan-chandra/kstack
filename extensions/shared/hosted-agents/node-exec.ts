/** Bounded `execFile` runner shared by the Herdr and Rex CLI gateways. */

import { execFile } from "node:child_process";
import type { BackendExec, ExecFailure } from "./terminal-backend.ts";

export function createNodeExec(
	binary: string,
	options: { label: string; maxBufferBytes: number; env?: NodeJS.ProcessEnv },
): BackendExec {
	const { label: name, maxBufferBytes, env } = options;
	return async (args, run) =>
		new Promise((resolve) => {
			execFile(
				binary,
				args,
				{
					timeout: run.timeoutMs,
					killSignal: "SIGKILL",
					maxBuffer: maxBufferBytes,
					signal: run.signal,
					...(env ? { env } : undefined),
				},
				(error, stdout, stderr) => {
					if (error === null) {
						resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
						return;
					}
					// Node reports exit codes as numbers and spawn failures as string codes.
					const exitCode = Number.parseInt(String(error.code), 10);
					const code = Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : 1;
					let failure: ExecFailure | undefined;
					let message = String(stderr);
					if (run.signal?.aborted) {
						failure = "aborted";
						message = `${name} command was aborted`;
					} else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
						// Node kills the child on overflow too; report the cause, not a timeout.
						failure = "overflow";
						message = `${name} output exceeded ${maxBufferBytes} bytes`;
					} else if (error.code === "ENOENT") {
						failure = "unavailable";
						message = `${name} binary was not found (${binary})`;
					} else if (error.killed) {
						failure = "timeout";
						message = `${name} command timed out after ${run.timeoutMs} ms`;
					} else if (message.length === 0) {
						message = error.message;
					}
					resolve({ code, stdout: String(stdout), stderr: message, ...(failure ? { failure } : undefined) });
				},
			);
		});
}
