/** Backend-neutral multiplexer port and environment-based backend selection.
 *
 * Hard invariant: Herdr and Rex never run together. Selection inspects only
 * environment variables; each backend's `preflight()` then validates the rest
 * of its required environment and server reachability.
 */

export type BackendKind = "herdr" | "rex";

export function backendLabel(kind: BackendKind): string {
	return kind === "herdr" ? "Herdr" : "Rex";
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "error" | "unknown";

/** Settled means ready for another request, not that the previous request succeeded. */
export function isSettledStatus(status: AgentStatus): boolean {
	return status === "idle" || status === "done" || status === "error";
}

export type BackendErrorCode =
	| "not_found"
	| "identity_unverified"
	| "pane_busy"
	| "agent_blocked"
	| "prompt_stalled"
	| "name_conflict"
	| "timeout"
	| "aborted"
	| "unavailable"
	| "protocol_error";

export interface BackendFailure {
	code: BackendErrorCode;
	message: string;
}

export type Outcome<T> = { ok: true; value: T } | ({ ok: false } & BackendFailure);

export interface AgentRef {
	name: string;
	paneId: string;
	stateFile?: string;
}

export interface AgentSnapshot {
	name: string;
	paneId: string;
	tabId: string;
	status: AgentStatus;
	cwd?: string;
	sessionFile?: string;
}

type BackendPreflight = { ok: true; caller: { paneId: string; tabId: string } } | { ok: false; error: string };

export interface ExecOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Why the subprocess runner, not the CLI, ended a command. */
export type ExecFailure = "aborted" | "timeout" | "unavailable" | "overflow";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	failure?: ExecFailure;
}

export type BackendExec = (args: string[], options: ExecOptions) => Promise<ExecResult>;

export function execFailureCode(failure: ExecFailure): BackendErrorCode {
	return failure === "overflow" ? "protocol_error" : failure;
}

export interface TerminalBackend {
	readonly kind: BackendKind;
	preflight(): Promise<BackendPreflight>;
	createTab(options: { cwd: string; label: string }): Promise<Outcome<{ tabId: string; rootPaneId: string }>>;
	splitPane(options: {
		paneId: string;
		direction: "right" | "down";
		keepFraction: number;
		cwd?: string;
		label?: string;
	}): Promise<Outcome<{ paneId: string; tabId: string }>>;
	paneGeometry(paneId: string): Promise<Outcome<{ widthColumns: number; heightRows: number; tabId: string }>>;
	closePane(paneId: string): Promise<Outcome<null>>;
	closeTab(tabId: string): Promise<Outcome<null>>;
	/** Launch Pi in an existing shell pane and wait for interactive readiness. */
	launchAgent(options: {
		name: string;
		paneId: string;
		cwd: string;
		piArgs: string[];
		stateFile: string;
		timeoutMs: number;
		signal?: AbortSignal;
	}): Promise<Outcome<AgentSnapshot>>;
	/** `not_found` means absent; ambiguous identity must fail with `identity_unverified`, never authorize stale-pane recovery. */
	getAgent(ref: AgentRef): Promise<Outcome<AgentSnapshot>>;
	findAgentsNamed(name: string): Promise<Outcome<AgentSnapshot[]>>;
	prompt(
		ref: AgentRef,
		text: string,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<Outcome<AgentSnapshot>>;
	waitSettled(ref: AgentRef, options: { timeoutMs: number; signal?: AbortSignal }): Promise<Outcome<AgentSnapshot>>;
	sendKeys(ref: AgentRef, keys: readonly ("esc" | "ctrl+c")[]): Promise<Outcome<null>>;
	/** Extra Pi args the backend needs, e.g. Herdr's `-e herdr-agent-state.ts`. */
	extraPiArgs(): string[];
}

type BackendSelection = { ok: true; kind: BackendKind } | { ok: false; error: string };

/** Pick the active terminal backend from environment variables alone. */
export function selectTerminalBackend(env: NodeJS.ProcessEnv = process.env): BackendSelection {
	const hasHerdr = env.HERDR_ENV === "1";
	const hasRex = Boolean(env.REX_SESSION?.trim() || env.REX_BLOCK?.trim());
	if (hasHerdr && hasRex) {
		return {
			ok: false,
			error:
				"Both Herdr and Rex were detected (HERDR_ENV=1 and REX_SESSION/REX_BLOCK). Kstack supports only one terminal multiplexer at a time.",
		};
	}
	if (hasHerdr) return { ok: true, kind: "herdr" };
	if (hasRex) return { ok: true, kind: "rex" };
	return {
		ok: false,
		error:
			"No supported terminal multiplexer detected. Run Pi inside Herdr (HERDR_ENV=1) or Rex (REX_SESSION and REX_BLOCK).",
	};
}
