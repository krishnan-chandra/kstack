/** Construct the active {@link TerminalBackend} and connect a preflighted session to it. */

import type { Clock } from "./clock.ts";
import { createHerdrBackend } from "./herdr/herdr-backend.ts";
import { createRexBackend } from "./rex/rex-backend.ts";
import { type BackendExec, type BackendKind, selectTerminalBackend, type TerminalBackend } from "./terminal-backend.ts";

export interface BackendDeps {
	/** Explicit backend adapter; when omitted, `selectTerminalBackend(env)` picks Herdr or Rex. */
	backend?: TerminalBackend;
	/** Subprocess runner for the selected backend CLI (`herdr` or `rex`). */
	exec?: BackendExec;
	env?: NodeJS.ProcessEnv;
	/** Time source for polling and retry delays. */
	clock?: Clock;
	/** Custom `pi` binary lookup for Rex launcher scripts. */
	resolvePiBinary?: (env: NodeJS.ProcessEnv) => string | undefined;
	/** Allow Rex preflight from a non-Pi shell block (opt-in e2e smoke only). */
	allowShellCaller?: boolean;
}

/** A backend whose preflight passed, plus the caller's live pane and tab. */
export interface TerminalSession {
	readonly backend: TerminalBackend;
	readonly caller: { readonly paneId: string; readonly tabId: string };
}

type Failure = { ok: false; error: string };

/** Resolve the active backend without spawning a CLI when selection fails. */
export function resolveTerminalBackend(deps: BackendDeps = {}): { ok: true; backend: TerminalBackend } | Failure {
	if (deps.backend) return { ok: true, backend: deps.backend };
	const env = deps.env ?? process.env;
	const selected = selectTerminalBackend(env);
	if (!selected.ok) return selected;
	const exec = deps.exec ? { exec: deps.exec } : undefined;
	if (selected.kind === "herdr") return { ok: true, backend: createHerdrBackend({ ...exec, env }) };
	return {
		ok: true,
		backend: createRexBackend({
			...exec,
			env,
			...(deps.clock ? { clock: deps.clock } : undefined),
			...(deps.resolvePiBinary ? { resolvePiBinary: deps.resolvePiBinary } : undefined),
			...(deps.allowShellCaller ? { allowShellCaller: deps.allowShellCaller } : undefined),
		}),
	};
}

/** Run a resolved backend's preflight once and bind the caller it reports. */
export async function connectBackend(
	backend: TerminalBackend,
): Promise<{ ok: true; session: TerminalSession } | Failure> {
	const preflight = await backend.preflight();
	if (!preflight.ok) return preflight;
	return { ok: true, session: { backend, caller: preflight.caller } };
}

/** Resolve and preflight the active backend before any model spend. */
export async function connectTerminal(
	deps: BackendDeps = {},
): Promise<{ ok: true; session: TerminalSession } | Failure> {
	const resolved = resolveTerminalBackend(deps);
	if (!resolved.ok) return resolved;
	return connectBackend(resolved.backend);
}

/* exported: cli.mjs preflight subcommand reports this shape as JSON */
export async function preflightTerminal(
	deps: BackendDeps = {},
): Promise<{ ok: true; backend: BackendKind; caller: TerminalSession["caller"] } | Failure> {
	const connected = await connectTerminal(deps);
	if (!connected.ok) return connected;
	return { ok: true, backend: connected.session.backend.kind, caller: connected.session.caller };
}
