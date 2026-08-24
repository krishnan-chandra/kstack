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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardCommandFallthrough } from "../shared/command-fallthrough.ts";
import { createHandoffHandler, type ReplacementSelectionApi, requireHandoffSource } from "./command.ts";
import { readHandoffHistory, searchHandoffHistory } from "./history-reader.ts";
import { completeHandoffArgs } from "./model-selection.ts";

// Pi re-runs this factory for every replacement runtime while reusing this
// module instance (the loader caches the factory and its module graph across
// session replacement). Rebinding here lets a /handoff handler that is still
// executing in the predecessor session apply model and effort to the
// replacement session through its live API.
let currentSessionApi: ReplacementSelectionApi | undefined;

export default async function (pi: ExtensionAPI) {
	guardCommandFallthrough(pi, "handoff");
	currentSessionApi = {
		setModel: (model) => pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]),
		setThinkingLevel: (level) => pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]),
	};
	const { Type, StringEnum } = await import("@earendil-works/pi-ai");

	pi.registerCommand("handoff", {
		description:
			"Continue in a lean session linked to current history (optional --archive, --model provider/model-id[:effort])",
		getArgumentCompletions: completeHandoffArgs,
		handler: createHandoffHandler(pi, { getReplacementApi: () => currentSessionApi }),
	});

	pi.registerTool({
		name: "read_handoff_history",
		label: "Read Handoff History",
		description:
			"Read normalized entries from the previous session linked by /handoff. Resolves the active JSONL first " +
			"and transparently falls back to the read-only archive by exact session ID. Defaults to the latest 50 " +
			"entries. Output is paginated and chunked. Read-only; accepts no filesystem path.",
		promptSnippet: "Read relevant entries from the previous session linked by /handoff",
		promptGuidelines: [
			"Use read_handoff_history before continuing work in a session created by /handoff; inspect the prior decisions and resume point without rereading unrelated history.",
		],
		parameters: Type.Object({
			offset: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 2_147_483_647, description: "Entry offset; overrides from" }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Entries per page (default 50)" })),
			chunk: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 1_000_000, description: "Chunk within this page (default 0)" }),
			),
			from: Type.Optional(
				StringEnum(["start", "tail"] as const, {
					description: "Read from the start or latest entries (default tail); ignored when offset is provided",
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
		name: "search_handoff_history",
		label: "Search Handoff History",
		description:
			"Search normalized text only within the previous session linked by /handoff. Searches the active JSONL " +
			"or transparently falls back to its archived FTS index. Read-only; accepts no filesystem path.",
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
}
