/**
 * Handoff extension — transfer context to a new focused session.
 *
 * Instead of compacting (lossy), handoff extracts what matters for the next
 * task, generates an editable continuation prompt, and creates a new session
 * linked to the old one via `parentSession` plus a durable `custom_message`
 * history reference.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff                        # infer the resume point and next step
 *
 * This file is Pi glue only. Formatting/prompt logic lives in
 * handoff-context.ts. The command handler is built by createHandoffHandler
 * with injected converters/loader so the lifecycle is testable without a Pi
 * runtime (see index.test.ts).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildHandoffConversationText,
	buildHandoffUserMessage,
	DEFAULT_HANDOFF_GOAL,
	ensureHistoryReference,
	estimateConversationTokens,
	formatHistoryReference,
	HANDOFF_SYSTEM_PROMPT,
	type ConversationConverters,
} from "./handoff-context.ts";

/** Minimal shape of Pi's BorderedLoader used by the handler. */
export interface HandoffLoader {
	readonly signal: AbortSignal;
	onAbort: (() => void) | undefined;
}

export type LoaderFactory = (
	tui: unknown,
	theme: unknown,
	message: string,
) => HandoffLoader & { [key: string]: unknown };

export interface HandoffDeps extends ConversationConverters {
	loaderFactory: LoaderFactory;
	/** Unique ID for the synthesis call (cache isolation). Defaults to crypto.randomUUID. */
	newCallId?: () => string;
	/** Fraction of the model context window the serialized history may use. */
	maxContextFraction?: number;
}

const DEFAULT_MAX_CONTEXT_FRACTION = 0.9;
const MAX_HANDOFF_OUTPUT_TOKENS = 4096;

/**
 * Build the /handoff command handler with injected Pi helpers. Kept separate
 * from registration so tests can drive the full lifecycle with fakes.
 */
export function createHandoffHandler(deps: HandoffDeps) {
	const maxFraction = deps.maxContextFraction ?? DEFAULT_MAX_CONTEXT_FRACTION;
	const newCallId = deps.newCallId ?? (() => crypto.randomUUID());

	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("handoff requires interactive mode", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}
		const model = ctx.model;

		const goal = args.trim() || DEFAULT_HANDOFF_GOAL;

		await ctx.waitForIdle();

		// Canonical compaction-aware projection of the active leaf. Do not
		// reimplement Pi's branch/compaction state machine here.
		const messages = ctx.sessionManager.buildSessionContext().messages;
		if (messages.length === 0) {
			ctx.ui.notify("No conversation to hand off", "error");
			return;
		}

		// Capture plain strings only — nothing session-bound may be reused
		// inside newSession's withSession callback (the old ctx is stale then).
		const oldFile = ctx.sessionManager.getSessionFile();
		const oldId = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd;
		const historyRef = formatHistoryReference(oldFile, oldId, cwd);

		const conversationText = buildHandoffConversationText(messages as AgentMessage[], deps);
		const handoffUserText = buildHandoffUserMessage(conversationText, goal, historyRef);

		// Budget the complete synthesis request rather than history alone. Reserve
		// the remainder of the context window for output and explicitly cap output
		// so providers that do not clamp maxTokens cannot reject an otherwise valid
		// request because input + their model default exceeds the context window.
		const estimatedTokens = estimateConversationTokens(`${HANDOFF_SYSTEM_PROMPT}\n\n${handoffUserText}`);
		const inputBudget = Math.floor(model.contextWindow * maxFraction);
		if (estimatedTokens > inputBudget) {
			ctx.ui.notify(
				`Handoff request is ~${estimatedTokens} tokens, over ${Math.round(maxFraction * 100)}% of the ` +
					`${model.contextWindow}-token context window. Run /compact first, then hand off.`,
				"error",
			);
			return;
		}
		const modelOutputLimit = model.maxTokens > 0 ? model.maxTokens : MAX_HANDOFF_OUTPUT_TOKENS;
		const outputBudget = Math.max(
			1,
			Math.min(modelOutputLimit, MAX_HANDOFF_OUTPUT_TOKENS, model.contextWindow - inputBudget),
		);

		// Generate the handoff prompt behind an abortable loader.
		let generateError: string | undefined;
		const generated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const loader = deps.loaderFactory(tui, theme, "Generating handoff prompt…");
			loader.onAbort = () => done(null);

			const doGenerate = async (): Promise<string | null> => {
				const userMessage = {
					role: "user" as const,
					content: [{ type: "text" as const, text: handoffUserText }],
					timestamp: Date.now(),
				};

				const response = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
					{ signal: loader.signal, cacheRetention: "none", sessionId: newCallId(), maxTokens: outputBudget },
				);

				if (response.stopReason === "aborted") {
					return null;
				}
				if (response.stopReason === "error") {
					throw new Error(response.errorMessage ?? "model returned an error");
				}
				if (response.stopReason !== "stop") {
					throw new Error(`model stopped before completing the handoff (${response.stopReason})`);
				}

				return response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			};

			doGenerate()
				.then(done)
				.catch((err) => {
					generateError = err instanceof Error ? err.message : String(err);
					done(null);
				});

			return loader as never;
		});

		if (generateError !== undefined) {
			ctx.ui.notify(`Handoff generation failed: ${generateError}`, "error");
			return;
		}
		if (generated === null) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (generated.trim() === "") {
			ctx.ui.notify("Handoff generation returned an empty prompt", "error");
			return;
		}

		// Do not trust model compliance for provenance: the prompt shown to the
		// user must contain the exact history block even if synthesis omitted or
		// rewrote it.
		const promptWithHistory = ensureHistoryReference(generated, historyRef);

		// Let the user review/edit the generated prompt.
		const edited = await ctx.ui.editor("Edit handoff prompt", promptWithHistory);
		if (edited === undefined) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		if (edited.trim() === "") {
			ctx.ui.notify("Handoff prompt cannot be empty", "error");
			return;
		}

		const result = await ctx.newSession({
			parentSession: oldFile,
			setup: async (sm) => {
				sm.appendCustomMessageEntry("handoff", historyRef, true);
			},
			withSession: async (fresh) => {
				fresh.ui.setEditorText(edited);
				fresh.ui.notify(`Handoff ready. Previous session: ${oldFile ?? "(ephemeral)"}`, "info");
			},
		});

		if (result.cancelled) {
			ctx.ui.notify("New session cancelled", "info");
		}
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			// Lazy import keeps this module loadable under plain `node --test`
			// (Pi's runtime packages are only resolvable inside Pi).
			const { BorderedLoader, convertToLlm, serializeConversation } = await import(
				"@earendil-works/pi-coding-agent"
			);
			const handler = createHandoffHandler({
				convertToLlm,
				serializeConversation,
				loaderFactory: (tui, theme, message) => new BorderedLoader(tui as never, theme as never, message),
			});
			return handler(args, ctx);
		},
	});
}
