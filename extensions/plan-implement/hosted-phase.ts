import type { WorkflowPhase } from "./lifecycle.ts";

interface HostedPhaseEffects {
	beginRole(phase: Exclude<WorkflowPhase, "idle" | "approval">): AbortController | undefined;
	endRole(controller: AbortController): void;
	isCurrent(): boolean;
	setStatus(status: string | undefined): void;
}

type HostedPhaseOutcome<T> = { status: "unavailable" } | { status: "ran"; value: T };

/** Owns abort-controller lifetime and session-safe status cleanup for one hosted phase. */
export async function runHostedPhase<T>(
	fx: HostedPhaseEffects,
	options: {
		phase: Exclude<WorkflowPhase, "idle" | "approval">;
		status: string;
		run(signal: AbortSignal): Promise<T>;
	},
): Promise<HostedPhaseOutcome<T>> {
	const controller = fx.beginRole(options.phase);
	if (!controller) return { status: "unavailable" };
	try {
		fx.setStatus(options.status);
		return { status: "ran", value: await options.run(controller.signal) };
	} finally {
		fx.endRole(controller);
		if (fx.isCurrent()) fx.setStatus(undefined);
	}
}
