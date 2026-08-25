/**
 * Thin Pi adapter for Graphite stacked-PR operations.
 *
 * Implements the shared stack provider channel contract for provider === "graphite".
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutopilotResult } from "../pr-autopilot/types.ts";
import { makeExec } from "../shared/git-exec.ts";
import { SessionRunLifecycle } from "../shared/session-lifecycle.ts";
import {
	claimStackCapabilities,
	claimStackLanding,
	claimStackPreflight,
	claimStackPublication,
	STACK_CAPABILITIES_EVENT,
	STACK_LANDING_EVENT,
	STACK_PREFLIGHT_EVENT,
	STACK_PUBLICATION_EVENT,
	type StackProviderCapabilities,
} from "../shared/stack/channel.ts";
import { preflightGraphiteStack, publishGraphiteStack } from "./delivery.ts";
import { type GraphiteLandingDeps, requestGraphiteStackLanding } from "./landing.ts";

const GRAPHITE_CAPABILITIES: StackProviderCapabilities = {
	schemaVersion: 1,
	publication: true,
};

class GraphiteStackLifecycle extends SessionRunLifecycle {
	begin() {
		const session = this.currentSessionToken();
		if (!session) return undefined;
		const run = this.beginRun(session);
		if (!run) return undefined;
		const signal = this.runSignal(run);
		if (!signal) {
			this.endRun(run);
			return undefined;
		}
		return { token: run, signal };
	}

	end(token: { generation: number }): void {
		this.endRun(token);
	}

	abort(): boolean {
		return this.abortRun();
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export default function graphiteStackedPrsExtension(pi: ExtensionAPI): void {
	const lifecycle = new GraphiteStackLifecycle();
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", async () => {
		lifecycle.shutdownSession();
	});

	const exec = makeExec(pi);

	async function withRun<T>(
		ctx: ExtensionContext,
		work: (signal: AbortSignal) => Promise<T>,
		idle: () => T,
	): Promise<T> {
		const token = lifecycle.begin();
		if (!token) return idle();
		try {
			return await work(token.signal);
		} finally {
			lifecycle.end(token.token);
			ctx.ui.setStatus("graphite-stack", undefined);
		}
	}

	pi.events.on(STACK_CAPABILITIES_EVENT, (data) =>
		claimStackCapabilities(data, "graphite", async () => GRAPHITE_CAPABILITIES),
	);

	pi.events.on(STACK_PREFLIGHT_EVENT, (data) =>
		claimStackPreflight(data, "graphite", async (payload) =>
			preflightGraphiteStack(payload.cwd, payload.manifestPath, exec),
		),
	);

	pi.events.on(STACK_PUBLICATION_EVENT, (data) =>
		claimStackPublication(data, "graphite", async (input, ctx) => {
			if (!ctx.hasUI) {
				return {
					status: "blocked",
					blockers: [{ code: "missing-ui", message: "Publication requires interactive TUI/RPC mode." }],
				};
			}
			return withRun(
				ctx,
				async (signal) => {
					ctx.ui.setStatus("graphite-stack", "graphite-stack: publishing");
					const publicationSignals = [signal];
					if (ctx.signal) publicationSignals.push(ctx.signal);
					if (input.signal) publicationSignals.push(input.signal);
					const publicationSignal = AbortSignal.any(publicationSignals);
					return publishGraphiteStack(
						input.repositoryPath,
						input.manifestPath,
						(title, body) => ctx.ui.confirm(title, body),
						exec,
						publicationSignal,
					);
				},
				() => ({ status: "busy" as const, message: "Another Graphite stack run is active." }),
			);
		}),
	);

	pi.events.on(STACK_LANDING_EVENT, (data) =>
		claimStackLanding(data, "graphite", async ({ input, capabilities, ctx }) => {
			if (!ctx.hasUI) {
				return {
					status: "stack",
					outcome: {
						status: "blocked",
						blockers: [
							{ code: "land-unavailable", message: "Graphite stack landing requires interactive TUI/RPC mode." },
						],
					},
				};
			}
			return withRun(
				ctx,
				async (signal) => {
					ctx.ui.setStatus("graphite-stack", "graphite-stack: validating stack");
					const landingSignals = [signal];
					if (ctx.signal) landingSignals.push(ctx.signal);
					if (input.signal) landingSignals.push(input.signal);
					const landingSignal = AbortSignal.any(landingSignals);
					const runAutopilot = capabilities.runAutopilot;
					const deps: GraphiteLandingDeps = {
						exec,
						cwd: input.repositoryPath,
						signal: landingSignal,
						runAutopilot: runAutopilot
							? async (mode, pr) => {
									const res = await runAutopilot(mode, pr);
									return /* SAFETY: The land capability owns and returns the AutopilotResult contract. */ res as
										| { handled: false }
										| { handled: true; outcome: AutopilotResult };
								}
							: async () => ({ handled: false }),
						confirmMerge: (preview) => ctx.ui.confirm("Confirm exact Graphite stack merge?", preview),
						now: Date.now,
						sleep: abortableSleep,
					};
					return requestGraphiteStackLanding(
						{
							prNumber: input.prNumber,
							readiness: input.readiness,
							method: input.method,
						},
						deps,
					);
				},
				() => ({
					status: "stack" as const,
					outcome: { status: "busy" as const, message: "Another Graphite stack run is active." },
				}),
			);
		}),
	);
}
