import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Result returned by an injected command runner. */
export interface ExecFnResult {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
}

/** Options shared by Git workstream command runners. */
interface ExecFnOptions {
	cwd: string;
	timeout?: number;
	signal?: AbortSignal;
}

/** Injected command runner shared by Git workstream policies. */
export type ExecFn = (command: string, args: string[], options: ExecFnOptions) => Promise<ExecFnResult>;

/** Run a bounded command and normalize every inconclusive execution into failure. */
export async function runCommand(
	exec: ExecFn,
	command: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeout = 15_000,
): Promise<ExecFnResult> {
	try {
		const result = await exec(command, args, { cwd, signal, timeout });
		if (result.killed && result.code === 0) {
			return { ...result, code: 1 };
		}
		return result;
	} catch (error) {
		return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

/** Select the bounded diagnostic text retained from a command result. */
export function commandDiagnostic(result: ExecFnResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

/** Adapt pi.exec to the shared command-runner shape. */
export function makeExec(pi: ExtensionAPI): ExecFn {
	return async (command, args, options) => {
		const result = await pi.exec(command, args, {
			cwd: options.cwd,
			timeout: options.timeout,
			signal: options.signal,
		});
		return {
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
			killed: result.killed,
		};
	};
}
