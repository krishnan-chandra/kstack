/** Ensure persisted Pi sessions have human-readable names before work begins. */

import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { normalizeSessionName, suggestSessionName } from "./names.ts";

type NamingApi = Pick<ExtensionAPI, "getSessionName" | "setSessionName">;
type NamingContext = Pick<ExtensionContext, "hasUI" | "sessionManager" | "ui">;

export function createSessionNamingHandler(api: NamingApi) {
	return async (event: InputEvent, ctx: NamingContext): Promise<InputEventResult> => {
		if (!ctx.sessionManager.getSessionFile() || api.getSessionName()) {
			return { action: "continue" };
		}

		const suggestion = suggestSessionName(event.text, ctx.sessionManager.getSessionId());
		let name = suggestion;
		if (ctx.hasUI && (event.source === "interactive" || event.source === "rpc")) {
			const entered = await ctx.ui.input("Name this session", suggestion);
			if (entered === undefined) {
				ctx.ui.notify("Prompt not sent. Name the session to continue.", "info");
				return { action: "handled" };
			}
			name = normalizeSessionName(entered) || suggestion;
		}

		try {
			api.setSessionName(name);
		} catch (error) {
			ctx.ui.notify(
				`Prompt not sent because the session could not be named: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { action: "handled" };
		}
		return { action: "continue" };
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("input", createSessionNamingHandler(pi));
}
