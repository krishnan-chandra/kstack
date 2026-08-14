/** Injected command runner shared by Git workstream policies. */
export interface ExecFnResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type ExecFn = (
	command: string,
	args: string[],
	options: { cwd: string; timeout?: number },
) => Promise<ExecFnResult>;
