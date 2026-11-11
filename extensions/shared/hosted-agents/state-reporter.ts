/** Env-gated Pi lifecycle hook that writes the hosted-agent sidecar state file.
 *
 * Registered from `kstack.ts`. Does nothing unless `KSTACK_HOSTED_AGENT_STATE`
 * holds an absolute path and Pi is running in interactive `"tui"` mode.
 */

import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type HostedAgentState,
	KSTACK_HOSTED_AGENT_NAME_ENV,
	KSTACK_HOSTED_AGENT_STATE_ENV,
	writeHostedAgentState,
} from "./agent-state.ts";

interface StateReporterDeps {
	env?: NodeJS.ProcessEnv;
	pid?: number;
	now?: () => string;
}

export function registerHostedAgentStateReporter(pi: ExtensionAPI, deps: StateReporterDeps = {}): void {
	const env = deps.env ?? process.env;
	const stateFile = env[KSTACK_HOSTED_AGENT_STATE_ENV]?.trim();
	if (!stateFile || !isAbsolute(stateFile)) return;
	const pid = deps.pid ?? process.pid;
	const now = deps.now ?? (() => new Date().toISOString());

	const publish = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		let sessionFile: string | undefined;
		let sessionId: string | undefined;
		try {
			const file = ctx.sessionManager.getSessionFile();
			if (file && isAbsolute(file)) sessionFile = file;
		} catch {
			/* ephemeral or unavailable session file */
		}
		try {
			const id = ctx.sessionManager.getSessionId();
			if (id && id.length > 0) sessionId = id;
		} catch {
			/* unavailable session id */
		}
		const state: HostedAgentState = {
			version: 1,
			name: env[KSTACK_HOSTED_AGENT_NAME_ENV] ?? "",
			pid,
			cwd: ctx.cwd,
			...(sessionFile ? { sessionFile } : undefined),
			...(sessionId ? { sessionId } : undefined),
			updatedAt: now(),
		};
		try {
			writeHostedAgentState(stateFile, state);
		} catch {
			/* best-effort sidecar telemetry; never crash the interactive session */
		}
	};

	pi.on("session_start", (_event, ctx) => {
		publish(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		publish(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		publish(ctx);
	});
}
