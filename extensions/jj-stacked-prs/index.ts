/** Thin Pi adapter for stacked-PR inspection, planning, and bounded mutation. */

import { Type, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRepoMethod, loadLandConfig, requestLand } from "../land/api.ts";
import { issueLandConfirmation } from "../land/confirmation.ts";
import { issueAutopilotConfirmation } from "../pr-autopilot/api.ts";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { isMergeMethod } from "../shared/github.ts";
import { SessionRunLifecycle } from "../shared/session-lifecycle.ts";
import {
	claimJjStackCapabilities,
	claimStackLanding,
	claimStackPublication,
	JJ_STACK_CAPABILITIES,
	JJ_STACK_CAPABILITIES_EVENT,
	JJ_STACK_LANDING_EVENT,
	JJ_STACK_PUBLICATION_EVENT,
} from "./api.ts";
import { completeJjStackArgs, parseJjStackArgs } from "./args.ts";
import { landStack, landStackFromTool, landStackThroughPullRequest } from "./land.ts";
import {
	advanceStack,
	inspectStack,
	type OrchestratorDeps,
	planStack,
	publishStack,
	publishStackFromTool,
	requestPublicationFromInput,
	type StackUi,
	syncStack,
} from "./orchestrator.ts";
import { generateDeterministicPrMetadata, type PrMetadataGenerator } from "./pr-metadata.ts";
import { createProcessRunner } from "./process.ts";
import { boundText, renderInspect, renderLandOutcome, renderOutcome, renderPlan } from "./render.ts";
import { combinePublicationSignals } from "./signals.ts";
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
	guardCommandFallthrough(pi, "jj-stack");
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

	function uiFrom(ctx: ExtensionContext): StackUi {
		return {
			hasUI: ctx.hasUI,
			confirm: (title, body) => ctx.ui.confirm(title, body),
			select: (title, values) => ctx.ui.select(title, values),
			notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
			setStatus: (status) => ctx.ui.setStatus("jj-stack", status),
		};
	}

	function metadataGenerator(ctx: ExtensionContext) {
		return {
			generate: async (request: Parameters<PrMetadataGenerator>[0]) => {
				ctx.ui.setStatus("jj-stack", `writing PR metadata: ${request.bookmark}`);
				return generateDeterministicPrMetadata(run, request);
			},
			usage: () => undefined,
		};
	}

	function publicationDeps(ctx: ExtensionContext, signal: AbortSignal) {
		const metadata = metadataGenerator(ctx);
		return {
			deps: { run, ui: uiFrom(ctx), signal, generatePrMetadata: metadata.generate },
			usage: metadata.usage,
		};
	}

	function landDeps(ctx: ExtensionContext, signal: AbortSignal): OrchestratorDeps {
		const configLoad = loadLandConfig();
		if (configLoad.status === "invalid") {
			ctx.ui.notify(`Invalid ${configLoad.path}: ${configLoad.error}`, "error");
		}
		const metadata = metadataGenerator(ctx);
		return {
			run,
			ui: uiFrom(ctx),
			signal,
			generatePrMetadata: metadata.generate,
			configuredMethodFor: (nameWithOwner) =>
				configLoad.status === "loaded" ? getRepoMethod(configLoad.config, nameWithOwner) : undefined,
			// Keep confirmation capability minting at this production boundary.
			landPr: async ({ prNumber, readiness, method }) =>
				requestLand(
					pi,
					{
						target: { kind: "single", prNumber },
						readiness,
						method,
						cwd: ctx.cwd,
						confirmation: issueLandConfirmation(),
						autopilotConfirmation: issueAutopilotConfirmation(),
					},
					ctx,
				),
		};
	}

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
				(signal) => {
					const combined = combinePublicationSignals(signal, ctx.signal);
					return requestPublicationFromInput(input, publicationDeps(ctx, combined).deps);
				},
				() => ({ status: "busy" as const, message: "Another stacked-PR run is active." }),
			);
		}),
	);
	pi.events.on(JJ_STACK_LANDING_EVENT, (data) =>
		claimStackLanding(data, async (input, ctx) => {
			if (!ctx.hasUI) {
				return {
					status: "stack",
					outcome: {
						status: "blocked",
						blockers: [{ code: "land-unavailable", message: "Stack landing requires interactive TUI/RPC mode." }],
					},
				};
			}
			return withRun(
				ctx,
				(signal) =>
					landStackThroughPullRequest(
						{
							cwd: input.repositoryPath,
							prNumber: input.prNumber,
							headBookmark: input.headBookmark,
							method: input.method,
							readiness: input.readiness,
						},
						landDeps(ctx, combinePublicationSignals(signal, ctx.signal)),
					),
				() => ({
					status: "stack" as const,
					outcome: { status: "busy" as const, message: "Another stacked-PR run is active." },
				}),
			);
		}),
	);

	pi.registerCommand("jj-stack", {
		description: "Inspect, plan, publish, sync, advance, or land a linear jj PR stack",
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
			if (command.action === "land") {
				const landOutcome = await withRun(
					ctx,
					(signal) =>
						landStack(
							{
								cwd: ctx.cwd,
								top: command.top,
								remote: command.remote,
								trunk: command.trunk,
								maxStack: command.maxStack,
								method: command.method,
								readiness: command.readiness,
							},
							landDeps(ctx, signal),
						),
					() => ({ status: "busy" as const, message: "Another stacked-PR run is active." }),
				);
				ctx.ui.notify(
					renderLandOutcome(landOutcome),
					landOutcome.status === "completed" || landOutcome.status === "declined" || landOutcome.status === "busy"
						? "info"
						: "warning",
				);
				return;
			}
			const outcome = await withRun(
				ctx,
				async (signal) => {
					if (command.action === "publish") {
						return publishStack(
							{
								cwd: ctx.cwd,
								top: command.top,
								remote: command.remote,
								trunk: command.trunk,
								maxStack: command.maxStack,
								ready: command.ready,
							},
							publicationDeps(ctx, signal).deps,
						);
					}
					const deps = { run, ui: uiFrom(ctx), signal };
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
			"Use jj_stack_publish only after the user explicitly asks to publish the current stack.",
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
			remote: Type.Optional(Type.String({ description: "Git remote name (default origin)" })),
			trunk: Type.Optional(Type.String({ description: "Trunk revset (default trunk())" })),
			maxStack: Type.Optional(Type.Integer({ minimum: MIN_MAX_STACK, maximum: DEFAULT_MAX_STACK })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const planned = await planStack(
				{
					cwd: ctx.cwd,
					top: params.top,
					remote: params.remote ?? "origin",
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

	pi.registerTool({
		name: "jj_stack_publish",
		label: "Publish stacked PRs",
		description:
			"Publish a linear jj bookmark stack by generating write-pr metadata from each exact slice, pushing bookmarks, creating draft PRs, repairing PR bases, and reconciling navigation comments. Mutates the remote immediately without UI confirmation.",
		promptSnippet: "Publish the current jj stack without a redundant confirmation after an explicit user request.",
		promptGuidelines: [
			"Call jj_stack_publish only when the user explicitly asks to publish the current stack; the tool mutates remotes without confirmation.",
			"Do not call jj_stack_publish merely because implementation or review finished.",
		],
		parameters: Type.Object({
			top: Type.String({ description: "Top bookmark" }),
			remote: Type.Optional(Type.String({ description: "Git remote name (default origin)" })),
			trunk: Type.Optional(Type.String({ description: "Trunk revset (default trunk())" })),
			maxStack: Type.Optional(Type.Integer({ minimum: MIN_MAX_STACK, maximum: DEFAULT_MAX_STACK })),
			ready: Type.Optional(
				Type.Boolean({ description: "Mark created and existing draft PRs ready after publication" }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			let nestedUsage: Usage | undefined;
			const outcome = await withRun(
				ctx,
				async (runSignal) => {
					const metadata = publicationDeps(ctx, combinePublicationSignals(runSignal, signal));
					const published = await publishStackFromTool(
						{
							cwd: ctx.cwd,
							top: params.top,
							remote: params.remote ?? "origin",
							trunk: params.trunk,
							maxStack: params.maxStack,
							ready: params.ready === true,
						},
						metadata.deps,
					);
					nestedUsage = metadata.usage();
					return published;
				},
				() => ({ status: "busy" as const, message: "Another stacked-PR run is active." }),
			);
			return {
				content: [{ type: "text" as const, text: boundText(renderOutcome(outcome)) }],
				details: outcome,
				usage: nestedUsage,
			};
		},
	});

	pi.registerTool({
		name: "jj_stack_land",
		label: "Land stacked PRs",
		description:
			"Land a linear jj bookmark stack bottom-up through the land extension. Marks drafts ready, merges each frontier, advances locally, republishes the remainder, and deletes verified merged branches. Mutates remotes immediately without UI confirmation.",
		promptSnippet: "Land the current jj stack without a redundant confirmation after an explicit user request.",
		promptGuidelines: [
			"Call jj_stack_land only when the user explicitly asks to land the current stack; landing merges to trunk and cannot be undone.",
			"Do not call jj_stack_land merely because implementation or review finished.",
		],
		parameters: Type.Object({
			top: Type.String({ description: "Top bookmark" }),
			remote: Type.Optional(Type.String({ description: "Git remote name (default origin)" })),
			trunk: Type.Optional(Type.String({ description: "Trunk revset (default trunk())" })),
			method: Type.Optional(
				Type.Union([Type.Literal("squash"), Type.Literal("rebase")], { description: "squash or rebase" }),
			),
			readiness: Type.Optional(
				Type.Union([Type.Literal("check"), Type.Literal("watch")], {
					description: "check or watch (default watch)",
				}),
			),
			maxStack: Type.Optional(Type.Integer({ minimum: MIN_MAX_STACK, maximum: DEFAULT_MAX_STACK })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const method = isMergeMethod(params.method) ? params.method : undefined;
			const readiness = params.readiness === "check" ? "check" : "watch";
			const outcome = await withRun(
				ctx,
				(runSignal) =>
					landStackFromTool(
						{
							cwd: ctx.cwd,
							top: params.top,
							remote: params.remote ?? "origin",
							trunk: params.trunk,
							maxStack: params.maxStack,
							method,
							readiness,
						},
						landDeps(ctx, combinePublicationSignals(runSignal, signal)),
					),
				() => ({ status: "busy" as const, message: "Another stacked-PR run is active." }),
			);
			return {
				content: [{ type: "text" as const, text: boundText(renderLandOutcome(outcome)) }],
				details: outcome,
			};
		},
	});
}

export type { StackPublicationRequestInput };
