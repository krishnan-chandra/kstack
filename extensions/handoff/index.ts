/**
 * Handoff extension — continue in a lean session that references the previous
 * session instead of copying or summarizing its conversation history.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff                        # continue from the prior resume point
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildReferenceHandoffPrompt,
	DEFAULT_HANDOFF_GOAL,
	formatHistoryReference,
} from "./handoff-context.ts";

/** Build the command handler separately so lifecycle behavior is easy to test. */
export function createHandoffHandler() {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("handoff requires interactive mode", "error");
			return;
		}

		const goal = args.trim() || DEFAULT_HANDOFF_GOAL;
		await ctx.waitForIdle();

		// Reference-only handoff requires a durable source artifact. An ephemeral
		// session cannot be recovered after replacement, so fail before editing or
		// creating anything.
		const oldFile = ctx.sessionManager.getSessionFile();
		if (oldFile === undefined) {
			ctx.ui.notify("handoff requires a persisted session and is unavailable with --no-session", "error");
			return;
		}

		// Capture only plain strings before replacement. The old command context
		// becomes stale after newSession succeeds.
		const oldId = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd;
		const historyRef = formatHistoryReference(oldFile, oldId, cwd);
		const draft = buildReferenceHandoffPrompt(goal, historyRef);

		const edited = await ctx.ui.editor("Edit handoff prompt", draft);
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
				fresh.ui.notify(`Handoff ready. Previous session: ${oldFile}`, "info");
			},
		});

		if (result.cancelled) {
			ctx.ui.notify("New session cancelled", "info");
		}
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Continue in a lean session linked to the current session's history",
		handler: createHandoffHandler(),
	});
}
