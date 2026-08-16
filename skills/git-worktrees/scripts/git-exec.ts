import { spawn } from "node:child_process";
import type { ExecFn, ExecFnResult } from "../../../extensions/shared/git-exec.ts";

const FORCE_KILL_DELAY_MS = 250;

export function createSkillExec(): ExecFn {
	return (command, args, options) =>
		new Promise<ExecFnResult>((resolveExec, rejectExec) => {
			const child = spawn(command, args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			let timedOut = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
			const timer =
				options.timeout === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							child.kill("SIGTERM");
							forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
						}, options.timeout);
			const clearTimers = (): void => {
				if (timer) clearTimeout(timer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
			};
			child.on("error", (error) => {
				clearTimers();
				rejectExec(error);
			});
			child.on("close", (code) => {
				clearTimers();
				if (timedOut) {
					rejectExec(new Error(`${command} timed out after ${options.timeout}ms`));
					return;
				}
				resolveExec({ code: code ?? 1, stdout, stderr });
			});
		});
}
