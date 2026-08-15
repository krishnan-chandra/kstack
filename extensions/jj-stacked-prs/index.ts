/** Thin Pi adapter for stacked-PR inspection, planning, and confirmed mutation. */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionRunLifecycle } from "../shared/session-lifecycle.ts";
import {
	claimJjStackCapabilities,
	claimStackPublication,
	JJ_STACK_CAPABILITIES,
	JJ_STACK_CAPABILITIES_EVENT,
	JJ_STACK_PUBLICATION_EVENT,
} from "./api.ts";
import { completeJjStackArgs, parseJjStackArgs } from "./args.ts";
import {
	advanceStack,
	inspectStack,
	planStack,
	publishStack,
	requestPublicationFromInput,
	type StackUi,
	syncStack,
} from "./orchestrator.ts";
import { createProcessRunner } from "./process.ts";
import { boundText, renderInspect, renderOutcome, renderPlan } from "./render.ts";
import { DEFAULT_MAX_STACK, MIN_MAX_STACK, type StackPublicationRequestInput } from "./types.ts";

class StackLifecycle extends SessionRunLifecycle {
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

export default function jjStackedPrsExtension(pi: ExtensionAPI): void {
	const lifecycle = new StackLifecycle();
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", async () => {
		lifecycle.shutdownSession();
	});
	pi.registerShortcut("ctrl+shift+j", {
		description: "Abort the active /jj-stack mutation",
		handler: async (ctx) => {
			ctx.ui.notify(lifecycle.abort() ? "Aborting stacked-PR mutation." : "No stacked-PR run is active.", "info");
		},
	});

	const run = createProcessRunner();

	function uiFrom(ctx: ExtensionCommandContext): StackUi {
		return {
			hasUI: ctx.hasUI,
			confirm: (title, body) => ctx.ui.confirm(title, body),
			select: (title, values) => ctx.ui.select(title, values),
			notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
			setStatus: (status) => ctx.ui.setStatus("jj-stack", status),
		};
	}

	async function withRun<T>(
		ctx: ExtensionCommandContext,
		work: (signal: AbortSignal) => Promise<T>,
		idle: () => T,
	): Promise<T> {
		const token = lifecycle.begin();
		if (!token) return idle();
		try {
			return await work(token.signal);
		} finally {
			lifecycle.end(token.token);
			ctx.ui.setStatus("jj-stack", undefined);
		}
	}

	pi.events.on(JJ_STACK_CAPABILITIES_EVENT, (data) =>
		claimJjStackCapabilities(data, async () => JJ_STACK_CAPABILITIES),
	);
	pi.events.on(JJ_STACK_PUBLICATION_EVENT, (data) =>
		claimStackPublication(data, async (input, ctx) => {
			if (!ctx.hasUI) {
				return {
					status: "blocked",
					blockers: [{ code: "missing-remote", message: "Publication requires interactive TUI/RPC mode." }],
				};
			}
			return withRun(
				ctx,
				(signal) =>
					requestPublicationFromInput(input, {
						run,
						ui: uiFrom(ctx),
						signal: mergeSignals(signal, input.signal),
					}),
				() => ({ status: "busy" as const, message: "Another stacked-PR run is active." }),
			);
		}),
	);

	pi.registerCommand("jj-stack", {
		description: "Inspect, plan, publish, sync, or advance a linear jj PR stack",
		getArgumentCompletions: completeJjStackArgs,
		handler: async (text, ctx) => {
			await ctx.waitForIdle();
			const parsed = parseJjStackArgs(text ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			const command = parsed.command;
			if (command.action === "inspect") {
				const model = await inspectStack(
					{ cwd: ctx.cwd, top: command.top, trunk: command.trunk, maxStack: command.maxStack },
					{ run, ui: uiFrom(ctx), signal: ctx.signal },
				);
				ctx.ui.notify(renderInspect(model), model.blockers.length > 0 ? "warning" : "info");
				return;
			}
			if (command.action === "plan") {
				const planned = await planStack(
					{
						cwd: ctx.cwd,
						top: command.top,
						remote: command.remote,
						trunk: command.trunk,
						maxStack: command.maxStack,
					},
					{ run, ui: uiFrom(ctx), signal: ctx.signal },
				);
				if (planned.status === "blocked") {
					ctx.ui.notify(renderInspect(planned.model), "warning");
					return;
				}
				ctx.ui.notify(renderPlan(planned.plan), "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("This /jj-stack action requires interactive TUI/RPC mode.", "error");
				return;
			}
			const outcome = await withRun(
				ctx,
				async (signal) => {
					const deps = { run, ui: uiFrom(ctx), signal };
					if (command.action === "publish") {
						return publishStack(
							{
								cwd: ctx.cwd,
								top: command.top,
								remote: command.remote,
								trunk: command.trunk,
								maxStack: command.maxStack,
							},
							deps,
						);
					}
					if (command.action === "sync") {
						return syncStack(
							{
								cwd: ctx.cwd,
								top: command.top,
								remote: command.remote,
								trunk: command.trunk,
								maxStack: command.maxStack,
							},
							deps,
						);
					}
					return advanceStack(
						{
							cwd: ctx.cwd,
							merged: command.merged,
							top: command.top,
							remote: command.remote,
							trunk: command.trunk,
							maxStack: command.maxStack,
						},
						deps,
					);
				},
				() => ({ status: "busy" as const, message: "Another stacked-PR run is active." }),
			);
			if ("status" in outcome && outcome.status === "completed") {
				ctx.ui.notify(
					"status" in outcome && "publication" in outcome ? renderOutcome(outcome) : "Stack command completed.",
					"info",
				);
			} else if ("status" in outcome && outcome.status === "declined") {
				ctx.ui.notify("Declined.", "info");
			} else if (
				"status" in outcome &&
				(outcome.status === "blocked" ||
					outcome.status === "failed" ||
					outcome.status === "partial" ||
					outcome.status === "indeterminate" ||
					outcome.status === "stale")
			) {
				ctx.ui.notify(
					"status" in outcome && "publication" in outcome ? renderOutcome(outcome) : JSON.stringify(outcome),
					"warning",
				);
			} else {
				ctx.ui.notify("status" in outcome && "message" in outcome ? outcome.message : JSON.stringify(outcome), "info");
			}
		},
	});

	pi.registerTool({
		name: "jj_stack_inspect",
		label: "Inspect jj stack",
		description: "Read-only inspection of the current linear jj bookmark stack.",
		promptSnippet: "Use jj_stack_inspect before and after stack history changes; refer to changes by stable change ID.",
		promptGuidelines: [
			"Use jj_stack_inspect before and after stack history changes.",
			"Refer to changes by stable change ID, not commit ID.",
			"Use jj, not mutating Git commands.",
			"Perform publication only through the confirmed /jj-stack publish command.",
		],
		parameters: Type.Object({
			top: Type.Optional(Type.String({ description: "Top bookmark; inferred when omitted" })),
			trunk: Type.Optional(Type.String({ description: "Trunk revset (default trunk())" })),
			maxStack: Type.Optional(Type.Integer({ minimum: MIN_MAX_STACK, maximum: DEFAULT_MAX_STACK })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const model = await inspectStack(
				{ cwd: ctx.cwd, top: params.top, trunk: params.trunk, maxStack: params.maxStack },
				{
					run,
					ui: {
						hasUI: false,
						confirm: async () => false,
						select: async () => undefined,
						notify: () => {},
						setStatus: () => {},
					},
					signal,
				},
			);
			return {
				content: [{ type: "text" as const, text: boundText(renderInspect(model)) }],
				details: model,
			};
		},
	});

	pi.registerTool({
		name: "jj_stack_plan",
		label: "Plan stacked PR publication",
		description: "Read-only publication plan for a linear jj bookmark stack. Never mutates remotes.",
		promptSnippet: "Use jj_stack_plan to preview stacked publication; a plan ID is not authorization to apply.",
		parameters: Type.Object({
			top: Type.String({ description: "Top bookmark" }),
			remote: Type.String({ description: "Git remote name" }),
			trunk: Type.Optional(Type.String({ description: "Trunk revset (default trunk())" })),
			maxStack: Type.Optional(Type.Integer({ minimum: MIN_MAX_STACK, maximum: DEFAULT_MAX_STACK })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const planned = await planStack(
				{
					cwd: ctx.cwd,
					top: params.top,
					remote: params.remote,
					trunk: params.trunk,
					maxStack: params.maxStack,
				},
				{
					run,
					ui: {
						hasUI: false,
						confirm: async () => false,
						select: async () => undefined,
						notify: () => {},
						setStatus: () => {},
					},
					signal,
				},
			);
			if (planned.status === "blocked") {
				return {
					content: [{ type: "text" as const, text: boundText(renderInspect(planned.model)) }],
					details: planned,
				};
			}
			return {
				content: [{ type: "text" as const, text: boundText(renderPlan(planned.plan)) }],
				details: planned,
			};
		},
	});
}

function mergeSignals(session: AbortSignal, extra?: AbortSignal): AbortSignal {
	if (!extra) return session;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([session, extra]);
	const merged = new AbortController();
	const abort = () => merged.abort();
	if (session.aborted || extra.aborted) merged.abort();
	else {
		session.addEventListener("abort", abort, { once: true });
		extra.addEventListener("abort", abort, { once: true });
	}
	return merged.signal;
}

export type { StackPublicationRequestInput };
