import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Result returned by an injected command runner. */
export interface ExecFnResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Options shared by Git workstream command runners. */
export interface ExecFnOptions {
	cwd: string;
	timeout?: number;
	signal?: AbortSignal;
}

/** Injected command runner shared by Git workstream policies. */
export type ExecFn = (command: string, args: string[], options: ExecFnOptions) => Promise<ExecFnResult>;

/** Adapt pi.exec to the shared command-runner shape. */
export function makeExec(pi: ExtensionAPI): ExecFn {
	return (command, args, options) =>
		pi.exec(command, args, {
			cwd: options.cwd,
			timeout: options.timeout,
			signal: options.signal,
		});
}
