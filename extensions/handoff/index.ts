/**
 * Handoff extension — continue in a lean session that references the previous
 * session instead of copying or summarizing its conversation history.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff --model anthropic/claude-sonnet-4-5 execute phase one of the plan
 *   /handoff --model openai/gpt-5.2:high continue the work
 *   /handoff                        # continue from the prior resume point
 *
 * Saving the editor is the only confirmation. The replacement session starts
 * immediately with that prompt; cancelling the editor leaves the old session.
 *
 * Model and effort selection: `--model` accepts `provider/model-id` or
 * `provider/model-id:<effort>` using Pi thinking levels (`off`, `minimal`,
 * `low`, `medium`, `high`, `xhigh`, `max`). Without a suffix, the parent
 * session's effective effort is inherited. Without `--model`, the parent model
 * and effort are inherited. The selection is applied to the replacement
 * session through its live extension API after it starts; handoff reports the
 * effective model and effort before the continuation prompt is sent.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { createHandoffHandler, createHandoffToolController, requireHandoffSource } from "./command.ts";
import { HANDOFF_HISTORY_TOOLS } from "./history-access.ts";
import { readHandoffHistory } from "./history-reader.ts";
import { searchHandoffHistory } from "./history-search.ts";
import { completeHandoffArgs, HANDOFF_EFFORT_LEVELS } from "./model-selection.ts";
import {
	bindReplacementSelectionApi,
	type ReplacementSelectionApi,
	unbindReplacementSelectionApi,
} from "./replacement-selection-api.ts";

export default async function (pi: ExtensionAPI) {
	guardCommandFallthrough(pi, "handoff");
	let selectionApi: ReplacementSelectionApi | undefined;
	const toolController = createHandoffToolController(pi, {
		sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
	});
	pi.on("session_start", (_event, ctx) => {
		selectionApi = {
			setModel: async (model) => {
				const resolved = ctx.modelRegistry.find(model.provider, model.id);
				return resolved ? pi.setModel(resolved) : false;
			},
			setThinkingLevel: (level) => pi.setThinkingLevel(level),
		};
		bindReplacementSelectionApi(ctx.sessionManager.getSessionId(), selectionApi);
	});
	pi.on("agent_settled", (event, ctx) => toolController.onAgentSettled(event, ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		toolController.onSessionShutdown(_event, ctx);
		if (selectionApi) unbindReplacementSelectionApi(ctx.sessionManager.getSessionId(), selectionApi);
	});

	pi.registerCommand("handoff", {
		description:
			"Continue in a lean session linked to current history (optional --archive, --model provider/model-id[:effort])",
		getArgumentCompletions: completeHandoffArgs,
		handler: createHandoffHandler(pi, { consumeToolRequest: toolController.consumeToolRequest }),
	});

	pi.registerTool({
		name: HANDOFF_HISTORY_TOOLS.read,
		label: "Read Handoff History",
		description:
			"Read the previous session linked by /handoff. The default outline maps the whole session with entry " +
			"numbers: requests, conclusions, tool activity, edit targets, and errors. view entries pages full " +
			"entries with tool output clipped to 800 bytes; full removes clipping. Resolves active or archived " +
			"storage by exact session ID. Read-only; accepts no filesystem path.",
		promptSnippet: "Outline the previous /handoff session, then expand only the entries you need",
		promptGuidelines: [
			'Use read_handoff_history with no arguments first in a session created by /handoff; expand only the entries you need with view: "entries" instead of paging through the whole history.',
		],
		parameters: Type.Object({
			view: Type.Optional(
				StringEnum(["outline", "entries"] as const, { description: "outline (default) or paged entries" }),
			),
			before: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 2_147_483_647, description: "Outline only entries before this number" }),
			),
			full: Type.Optional(Type.Boolean({ description: "Entries view: do not clip tool output" })),
			offset: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 2_147_483_647, description: "Entry offset; overrides from" }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Entries per page (default 50)" })),
			chunk: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Chunk within this page (default 0)" }),
			),
			from: Type.Optional(
				StringEnum(["start", "tail"] as const, {
					description: "Page from the start or latest entries (default tail); ignored when offset is provided",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const source = requireHandoffSource(ctx);
			const text = readHandoffHistory(source, params);
			return { content: [{ type: "text" as const, text }], details: { sessionId: source.sessionId } };
		},
	});

	pi.registerTool({
		name: HANDOFF_HISTORY_TOOLS.search,
		label: "Search Handoff History",
		description:
			"Search only the previous session linked by /handoff, including tool-call paths and commands. Returns " +
			"short snippets with entry numbers to expand with read_handoff_history. Read-only; accepts no filesystem path.",
		promptSnippet: "Search the previous /handoff session for a decision, file, error, or topic",
		promptGuidelines: [
			"Use search_handoff_history for targeted lookup when read_handoff_history would retrieve unrelated prior entries.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Plain words or quoted phrases to find in the previous session" }),
			role: Type.Optional(Type.String({ description: "Only entries with this role, such as user or assistant" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum matches (default 20)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const source = requireHandoffSource(ctx);
			const text = searchHandoffHistory(source, params);
			return { content: [{ type: "text" as const, text }], details: { sessionId: source.sessionId } };
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Handoff Session",
		description:
			"Hand off to a fresh, lean Pi session linked to this session's history once this turn settles. " +
			"Supports goal, target model/effort selection, and optional archive-first mode.",
		promptSnippet: "Hand off to a fresh lean session linked to this session's history once this turn settles",
		promptGuidelines: [
			"Call handoff only when the user explicitly asks to hand off to a new session or when the current workflow explicitly directs a handoff; it replaces the current session once this turn settles.",
			"Do not call handoff merely because a task finished.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			goal: Type.Optional(
				Type.String({
					description: "Continuation goal for the replacement session; defaults to the previous resume point.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Target model reference (provider/model-id, bare id, kstack.json label, display name, or unique partial match) with optional :<effort>.",
				}),
			),
			effort: Type.Optional(
				StringEnum(HANDOFF_EFFORT_LEVELS, {
					description: "Thinking level for the replacement session; inherits parent effort when omitted.",
				}),
			),
			archive: Type.Optional(
				Type.Boolean({
					description:
						"Archive the current session before starting the replacement session (also allows >64 MiB sources).",
				}),
			),
		}),
		execute: toolController.execute,
	});
}
