import type { SpawnedProcess } from "./child-agent-runner.ts";
import { type BoundaryValue, isObject, isString } from "./validation.ts";

export interface ProcessGroupSystem {
	killGroup(groupId: number, signal: "SIGTERM" | "SIGKILL" | 0): void;
}

export const defaultProcessGroupSystem: ProcessGroupSystem = {
	killGroup(groupId: number, signal: "SIGTERM" | "SIGKILL" | 0): void {
		process.kill(-groupId, signal);
	},
};

type StopOutcome = { ok: true } | { ok: false; cleanupError: string };

interface ChildProcessStopOptions {
	child: SpawnedProcess;
	groupId?: number;
	killGraceMs?: number;
	postEscalationGraceMs?: number;
	pollIntervalMs?: number;
	system?: ProcessGroupSystem;
	sleep?: (ms: number) => Promise<void>;
}

interface ChildProcessStopCoordinator {
	stop(): Promise<StopOutcome>;
	notifyClosed(): void;
	isStopStarted(): boolean;
}

function isEsrch(error: BoundaryValue): boolean {
	if (error instanceof Error && error.message.includes("ESRCH")) return true;
	if (!isObject(error) || error === null || !("code" in error)) return false;
	return error.code === "ESRCH";
}

function errorMessage(error: BoundaryValue): string {
	if (error instanceof Error) return error.message;
	if (isString(error)) return error;
	return String(error);
}

export function createChildProcessStopCoordinator(options: ChildProcessStopOptions): ChildProcessStopCoordinator {
	const { child, groupId } = options;
	const killGraceMs = options.killGraceMs ?? 5000;
	const postEscalationGraceMs = options.postEscalationGraceMs ?? Math.min(killGraceMs, 1000);
	const pollIntervalMs = options.pollIntervalMs ?? Math.max(1, Math.min(25, Math.floor(killGraceMs / 5)));
	const system = options.system ?? defaultProcessGroupSystem;
	const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

	let stopPromise: Promise<StopOutcome> | undefined;
	let closed = false;
	let onClosedCallback: (() => void) | undefined;

	const notifyClosed = () => {
		closed = true;
		onClosedCallback?.();
	};

	const isStopStarted = () => stopPromise !== undefined;

	const runFallbackStop = (): Promise<StopOutcome> => {
		return new Promise<StopOutcome>((resolve) => {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already exited */
			}
			if (closed) {
				resolve({ ok: true });
				return;
			}
			let resolved = false;
			let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
			const settleFallback = () => {
				if (resolved) return;
				resolved = true;
				if (fallbackTimer) clearTimeout(fallbackTimer);
				resolve({ ok: true });
			};
			onClosedCallback = settleFallback;
			fallbackTimer = setTimeout(() => {
				if (!closed) {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already exited */
					}
				}
				settleFallback();
			}, killGraceMs);
		});
	};

	const runGroupStop = async (pgid: number): Promise<StopOutcome> => {
		// Phase 1: Initial SIGTERM to the owned group
		try {
			system.killGroup(pgid, "SIGTERM");
		} catch (error) {
			if (isEsrch(error)) {
				// Process group is already absent
				return { ok: true };
			}
			return {
				ok: false,
				cleanupError: `Failed signaling process group ${pgid} with SIGTERM: ${errorMessage(error)}`,
			};
		}
		try {
			child.kill("SIGTERM");
		} catch {
			/* direct child already exited or unsupported */
		}

		// Phase 2: Poll group absence during grace period (killGraceMs)
		const graceDeadline = Date.now() + killGraceMs;
		while (Date.now() < graceDeadline) {
			const remaining = graceDeadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(pollIntervalMs, remaining));

			try {
				system.killGroup(pgid, 0);
				// Process group is still alive; continue waiting
			} catch (error) {
				if (isEsrch(error)) {
					// Absence observed before grace expired; never signal again
					return { ok: true };
				}
				return {
					ok: false,
					cleanupError: `Failed inspecting process group ${pgid}: ${errorMessage(error)}`,
				};
			}
		}

		// Check one final time before escalating to SIGKILL
		try {
			system.killGroup(pgid, 0);
		} catch (error) {
			if (isEsrch(error)) {
				return { ok: true };
			}
			return {
				ok: false,
				cleanupError: `Failed inspecting process group ${pgid}: ${errorMessage(error)}`,
			};
		}

		// Phase 3: Escalation to SIGKILL
		try {
			system.killGroup(pgid, "SIGKILL");
		} catch (error) {
			if (isEsrch(error)) {
				return { ok: true };
			}
			return {
				ok: false,
				cleanupError: `Failed signaling process group ${pgid} with SIGKILL: ${errorMessage(error)}`,
			};
		}
		try {
			child.kill("SIGKILL");
		} catch {
			/* direct child already exited or unsupported */
		}

		// Phase 4: Bounded post-escalation observation window
		const postDeadline = Date.now() + postEscalationGraceMs;
		while (Date.now() < postDeadline) {
			const remaining = postDeadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(pollIntervalMs, remaining));

			try {
				system.killGroup(pgid, 0);
			} catch (error) {
				if (isEsrch(error)) {
					// Absence observed after SIGKILL
					return { ok: true };
				}
				return {
					ok: false,
					cleanupError: `Failed inspecting process group ${pgid} after SIGKILL: ${errorMessage(error)}`,
				};
			}
		}

		// Final check after post-escalation window expires
		try {
			system.killGroup(pgid, 0);
			return {
				ok: false,
				cleanupError: `Process group ${pgid} remained active after SIGKILL (${postEscalationGraceMs}ms observation window)`,
			};
		} catch (error) {
			if (isEsrch(error)) {
				return { ok: true };
			}
			return {
				ok: false,
				cleanupError: `Failed inspecting process group ${pgid} after SIGKILL: ${errorMessage(error)}`,
			};
		}
	};

	const stop = (): Promise<StopOutcome> => {
		if (stopPromise) return stopPromise;
		if (groupId === undefined) {
			stopPromise = runFallbackStop();
		} else {
			stopPromise = runGroupStop(groupId);
		}
		return stopPromise;
	};

	return {
		stop,
		notifyClosed,
		isStopStarted,
	};
}
