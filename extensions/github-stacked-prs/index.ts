/** Thin Pi adapter for GitHub-native stacked PR publication and landing. */

import { type ExtensionAPI, type ExtensionContext, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { requestStackFrontierLand } from "../land/api.ts";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { makeExec } from "../shared/git-exec.ts";
import { createGitHubGateway, isMergeMethod } from "../shared/github.ts";
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
import type { StackPublishOutcome } from "../shared/stack/outcome.ts";
import { completeGitHubStackArgs, parseGitHubStackArgs } from "./args.ts";
import { preflightGitHubStack, publishGitHubManifestFile, publishGitHubStack } from "./delivery.ts";
import { discoverGitHubStack } from "./discovery.ts";
import { requestGitHubStackLanding } from "./landing.ts";

const CAPABILITIES: StackProviderCapabilities = {
	schemaVersion: 1,
	publication: true,
	commands: ["publish"],
	tools: ["gh_stack_publish"],
};

class GitHubStackLifecycle extends SessionRunLifecycle {
	begin() {
		const session = this.currentSessionToken();
		if (!session) return undefined;
		const token = this.beginRun(session);
		if (!token) return undefined;
		const signal = this.runSignal(token);
		return signal ? { token, signal } : undefined;
	}
}

function combineSignals(primary: AbortSignal, ...others: Array<AbortSignal | undefined>): AbortSignal {
	const signals = [primary, ...others].filter((signal): signal is AbortSignal => signal !== undefined);
	return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export function renderOutcome(outcome: StackPublishOutcome): string {
	const text = JSON.stringify(outcome, null, 2);
	const marker = "\n[Output truncated]";
	const truncated = truncateHead(text, {
		maxBytes: 50 * 1024 - Buffer.byteLength(marker, "utf8"),
		maxLines: 2_000,
	});
	return truncated.truncated ? `${truncated.content}${marker}` : text;
}

export default function githubStackedPrsExtension(pi: ExtensionAPI): void {
	guardCommandFallthrough(pi, "gh-stack");
	const lifecycle = new GitHubStackLifecycle();
	lifecycle.startSession();
	pi.on("session_start", () => lifecycle.startSession());
	pi.on("session_shutdown", () => lifecycle.shutdownSession());
	const exec = makeExec(pi);
	const gateway = createGitHubGateway(exec);

	async function withRun<T>(
		ctx: ExtensionContext,
		work: (signal: AbortSignal) => Promise<T>,
		busy: () => T,
	): Promise<T> {
		const active = lifecycle.begin();
		if (!active) return busy();
		try {
			return await work(active.signal);
		} finally {
			lifecycle.endRun(active.token);
			ctx.ui.setStatus("gh-stack", undefined);
		}
	}

	async function discoverAndPublish(input: {
		cwd: string;
		top: string;
		remote: string;
		ready: boolean;
		authorization: "interactive-confirmation" | "model-tool";
		confirm(title: string, body: string): Promise<boolean>;
		signal: AbortSignal;
	}): Promise<StackPublishOutcome> {
		const discovered = await discoverGitHubStack({
			cwd: input.cwd,
			top: input.top,
			remote: input.remote,
			exec,
			gateway,
			signal: input.signal,
		});
		if (!discovered.ok) {
			return { status: "blocked", blockers: [{ code: "github-discovery", message: discovered.error }] };
		}
		return publishGitHubStack({
			cwd: discovered.repositoryRoot,
			manifest: discovered.manifest,
			remote: input.remote,
			ready: input.ready,
			authorization: input.authorization,
			deps: { exec, gateway, confirm: input.confirm, signal: input.signal },
		});
	}

	pi.events.on(STACK_CAPABILITIES_EVENT, (data) => claimStackCapabilities(data, "github", async () => CAPABILITIES));
	pi.events.on(STACK_PREFLIGHT_EVENT, (data) =>
		claimStackPreflight(data, "github", (payload) =>
			preflightGitHubStack(payload.cwd, payload.manifestPath, exec, gateway),
		),
	);
	pi.events.on(STACK_PUBLICATION_EVENT, (data) =>
		claimStackPublication(data, "github", async (input, ctx) => {
			if (!ctx.hasUI) {
				return {
					status: "blocked",
					blockers: [{ code: "missing-ui", message: "Publication requires interactive TUI/RPC mode." }],
				};
			}
			return withRun(
				ctx,
				(signal) => {
					ctx.ui.setStatus("gh-stack", "gh-stack: publishing");
					return publishGitHubManifestFile({
						cwd: input.repositoryPath,
						manifestPath: input.manifestPath,
						remote: input.remote ?? "origin",
						ready: false,
						deps: {
							exec,
							gateway,
							confirm: (title, body) => ctx.ui.confirm(title, body),
							signal: combineSignals(signal, ctx.signal, input.signal),
						},
					});
				},
				() => ({ status: "busy" as const, message: "Another GitHub stack run is active." }),
			);
		}),
	);
	pi.events.on(STACK_LANDING_EVENT, (data) =>
		claimStackLanding(data, "github", async ({ input, ctx }) => {
			if (!ctx.hasUI) {
				return {
					status: "stack",
					outcome: {
						status: "blocked",
						blockers: [{ code: "missing-ui", message: "GitHub stack landing requires interactive TUI/RPC mode." }],
					},
				};
			}
			return withRun(
				ctx,
				(signal) => {
					ctx.ui.setStatus("gh-stack", "gh-stack: landing");
					const combined = combineSignals(signal, ctx.signal, input.signal);
					return requestGitHubStackLanding(
						{
							cwd: input.repositoryPath,
							prNumber: input.prNumber,
							headRef: input.headRef,
							readiness: input.readiness,
							method: input.method,
						},
						{
							exec,
							gateway,
							confirm: (title, body) => ctx.ui.confirm(title, body),
							selectMethod: async (allowed) => {
								const selected = await ctx.ui.select("Select an allowed merge method", [...allowed]);
								return isMergeMethod(selected) ? selected : undefined;
							},
							landFrontier: ({ prNumber, expectedHeadSha, readiness, method }) =>
								requestStackFrontierLand(pi, {
									options: { target: { kind: "single", prNumber }, readiness, method, cwd: input.repositoryPath },
									expectedHeadSha,
									signal: combined,
									ctx,
								}),
							signal: combined,
						},
					);
				},
				() => ({
					status: "stack" as const,
					outcome: { status: "busy" as const, message: "Another GitHub stack run is active." },
				}),
			);
		}),
	);

	pi.registerCommand("gh-stack", {
		description: "Publish a local GitHub-native stack: /gh-stack publish --top <branch> [--remote origin] [--ready]",
		getArgumentCompletions: completeGitHubStackArgs,
		handler: async (text, ctx) => {
			await ctx.waitForIdle();
			const parsed = parseGitHubStackArgs(text ?? "");
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/gh-stack publish requires interactive TUI/RPC mode.", "error");
				return;
			}
			const outcome = await withRun(
				ctx,
				(signal) =>
					discoverAndPublish({
						cwd: ctx.cwd,
						top: parsed.command.top,
						remote: parsed.command.remote,
						ready: parsed.command.ready,
						authorization: "interactive-confirmation",
						confirm: (title, body) => ctx.ui.confirm(title, body),
						signal,
					}),
				() => ({ status: "busy" as const, message: "Another GitHub stack run is active." }),
			);
			ctx.ui.notify(renderOutcome(outcome), outcome.status === "completed" ? "info" : "warning");
		},
	});

	pi.registerTool({
		name: "gh_stack_publish",
		label: "Publish GitHub stack",
		description:
			"Publish a linear local Git branch stack by pushing kstack/ branches with exact leases, creating draft PRs, repairing bases, and reconciling navigation comments. Mutates the remote immediately without UI confirmation.",
		promptSnippet:
			"Publish the current GitHub-native stack without a redundant confirmation after an explicit user request.",
		promptGuidelines: [
			"Call gh_stack_publish only when the user explicitly asks to publish the current stack; the tool mutates remotes without confirmation.",
			"Do not call gh_stack_publish merely because implementation or review finished.",
		],
		parameters: Type.Object({
			top: Type.String({ description: "Top local kstack/ branch" }),
			remote: Type.Optional(Type.String({ description: "Git remote name (default origin)" })),
			ready: Type.Optional(Type.Boolean({ description: "Mark created and existing draft PRs ready" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const outcome = await withRun(
				ctx,
				(runSignal) =>
					discoverAndPublish({
						cwd: ctx.cwd,
						top: params.top,
						remote: params.remote ?? "origin",
						ready: params.ready === true,
						authorization: "model-tool",
						confirm: async () => true,
						signal: combineSignals(runSignal, signal),
					}),
				() => ({ status: "busy" as const, message: "Another GitHub stack run is active." }),
			);
			return { content: [{ type: "text" as const, text: renderOutcome(outcome) }], details: outcome };
		},
	});
}
