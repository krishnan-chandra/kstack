/** Pane allocation and agent startup for groups of hosted Pi agents (Herdr or Rex).
 *
 * `openAgentHost` owns a new background tab (or Rex window); `openPaneHost`
 * splits the caller's own pane and hosts the agents as siblings in the
 * caller's tab, which it never closes. Either way panes are retained by
 * default so the user can keep talking to the agents. The request lifecycle
 * lives in `./hosted-agent.ts`; multiplexer commands live behind
 * {@link TerminalBackend} in `./herdr/` and `./rex/`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type HostedAgentSpec, hostedAgentArgs, isValidAgentName, randomAgentName } from "./agent-spec.ts";
import { type BackendDeps, connectTerminal, type TerminalSession } from "./backends.ts";
import { systemClock } from "./clock.ts";
import { sameCwd } from "./cwd.ts";
import { errorText, type HostedAgent, HostedAgentImpl } from "./hosted-agent.ts";
import {
	type AgentPanePlacement,
	type PaneSplitDecision,
	type PaneSplitDirection,
	paneSplitDecision,
	placeAgent,
} from "./layout.ts";
import {
	type AgentSnapshot,
	type BackendKind,
	backendLabel,
	type Outcome,
	type TerminalBackend,
} from "./terminal-backend.ts";

/** A failed start reports the pane it reserved and the name it tried, when known. */
interface StartFailure {
	ok: false;
	error: string;
	aborted?: boolean;
	paneId?: string;
	name?: string;
}

export interface AgentHost {
	readonly backend: BackendKind;
	readonly tabId: string;
	/** 0700 exchange directory for instruction and answer files. */
	readonly exchangeDir: string;
	start(spec: HostedAgentSpec): Promise<{ ok: true; agent: HostedAgent } | StartFailure>;
	/**
	 * `closeTab` closes the host tab, or every pane a pane host split off.
	 * `closeUnassignedPanes` closes only owned panes no agent start ever
	 * reserved, such as a pane host's first split after a cancelled start.
	 */
	dispose(options?: { closeTab?: boolean; closeUnassignedPanes?: boolean }): Promise<void>;
}

export interface HostDeps extends BackendDeps {
	/** Overrides the auto-created exchange directory (tests inject a fixture path). */
	exchangeDir?: string;
}

type OpenResult = { ok: true; host: AgentHost } | { ok: false; error: string };

const START_TIMEOUT_MIN_MS = 3_000;
const START_TIMEOUT_MAX_MS = 300_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const MAX_AGENTS_PER_HOST = 8;
const PANE_BUSY_RETRIES = 3;
const PANE_BUSY_RETRY_DELAY_MS = 1_000;

/** Container a hosted-agent group lives in: its own tab, or a split of the caller's pane. */
interface HostBase {
	kind: "tab" | "pane";
	tabId: string;
	rootPaneId: string;
	widthColumns: number;
}

function validMaxAgents(maxAgents: number): boolean {
	return Number.isInteger(maxAgents) && maxAgents >= 1 && maxAgents <= MAX_AGENTS_PER_HOST;
}

/** Create the host: preflight, one background tab/window, a 0700 exchange directory. */
export async function openAgentHost(
	options: { owner: string; label: string; cwd: string; maxAgents: number },
	deps: HostDeps,
): Promise<OpenResult> {
	const connected = await connectTerminal(deps);
	if (!connected.ok) return connected;
	const { backend } = connected.session;
	if (!validMaxAgents(options.maxAgents)) {
		return { ok: false, error: `maxAgents must be an integer from 1 to ${MAX_AGENTS_PER_HOST}.` };
	}
	const tab = await backend.createTab({ cwd: options.cwd, label: `${options.owner}: ${options.label}` });
	if (!tab.ok) {
		return { ok: false, error: `Could not create the ${backendLabel(backend.kind)} tab: ${tab.message}` };
	}
	const layout = await backend.paneGeometry(tab.value.rootPaneId);
	return {
		ok: true,
		host: await buildHost(options, deps, backend, {
			kind: "tab",
			tabId: tab.value.tabId,
			rootPaneId: tab.value.rootPaneId,
			widthColumns: layout.ok ? layout.value.widthColumns : 240,
		}),
	};
}

/**
 * Create the host in a new split of the caller's own pane instead of a separate
 * tab. The caller's tab is never closed by `dispose`, so the reviewer stays
 * visible for inspection and steering.
 */
export async function openPaneHost(options: PaneHostOptions, deps: HostDeps): Promise<OpenResult> {
	const connected = await connectTerminal(deps);
	if (!connected.ok) return connected;
	return openPaneHostIn(connected.session, options, deps);
}

/** {@link openPaneHost} for a caller that already holds a preflighted session. */
export async function openPaneHostIn(
	session: TerminalSession,
	options: PaneHostOptions,
	deps: HostDeps,
): Promise<OpenResult> {
	const { backend, caller } = session;
	if (!validMaxAgents(options.maxAgents)) {
		return { ok: false, error: `maxAgents must be an integer from 1 to ${MAX_AGENTS_PER_HOST}.` };
	}
	let decision: PaneSplitDecision;
	if (options.direction) {
		decision = { direction: options.direction, ratio: 0.5 };
	} else {
		const callerLayout = await backend.paneGeometry(caller.paneId);
		decision = paneSplitDecision(callerLayout.ok ? callerLayout.value : { widthColumns: 240, heightRows: 60 });
	}
	const split = await backend.splitPane({
		paneId: caller.paneId,
		direction: decision.direction,
		keepFraction: decision.ratio,
		cwd: options.cwd,
	});
	if (!split.ok) {
		return { ok: false, error: `Could not split the caller's ${backendLabel(backend.kind)} pane: ${split.message}` };
	}
	try {
		const layout = await backend.paneGeometry(split.value.paneId);
		return {
			ok: true,
			host: await buildHost(options, deps, backend, {
				kind: "pane",
				tabId: split.value.tabId,
				rootPaneId: split.value.paneId,
				widthColumns: layout.ok ? layout.value.widthColumns : 240,
			}),
		};
	} catch (error) {
		try {
			const closed = await backend.closePane(split.value.paneId);
			if (!closed.ok) throw new Error(closed.message);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`Pane host construction failed: ${errorText(error)}; rollback of ${split.value.paneId} also failed: ${errorText(cleanupError)}`,
				{ cause: error },
			);
		}
		throw error;
	}
}

interface HostOptions {
	owner: string;
	label: string;
	cwd: string;
	maxAgents: number;
	/** Cap on agent grid columns inside the host; 1 stacks agents vertically. */
	maxColumns?: number;
}

interface PaneHostOptions extends HostOptions {
	/** Split the caller's pane this way instead of choosing from its geometry. */
	direction?: PaneSplitDirection;
}

/** Internal signal that a queued agent start was cancelled before or during launch. */
class StartCancelledError extends Error {}

async function buildHost(
	options: HostOptions,
	deps: HostDeps,
	backend: TerminalBackend,
	base: HostBase,
): Promise<AgentHost> {
	const clock = deps.clock ?? systemClock;
	const ownsExchangeDir = deps.exchangeDir === undefined;
	const exchangeDir = deps.exchangeDir ?? (await createExchangeDir());
	const agents: HostedAgentImpl[] = [];
	const panes: string[] = [];
	// Panes this host created. A pane host owns its initial split even before an
	// agent starts there, so cleanup cannot leave an orphan split behind.
	const ownedPanes = new Set(base.kind === "pane" ? [base.rootPaneId] : []);
	let allocation = Promise.resolve();
	let disposed = false;

	const allocatePane = (spec: HostedAgentSpec): Promise<string> => {
		const next = allocation.then(async () => {
			if (disposed) throw new Error("The agent host is disposed.");
			if (spec.signal?.aborted) throw new StartCancelledError();
			if (panes.length >= options.maxAgents) throw new Error(`This run hosts at most ${options.maxAgents} agent(s).`);
			const index = panes.length;
			const placement: AgentPanePlacement | undefined = placeAgent(index, options.maxAgents, {
				widthColumns: base.widthColumns,
				...(options.maxColumns ? { maxColumns: options.maxColumns } : undefined),
			});
			let paneId = base.rootPaneId;
			if (placement || resolve(spec.cwd) !== resolve(options.cwd)) {
				const sourcePane =
					placement && placement.splitFrom !== "root"
						? (panes[placement.splitFrom] ?? base.rootPaneId)
						: base.rootPaneId;
				const split = await backend.splitPane({
					paneId: sourcePane,
					direction: placement?.direction ?? "right",
					keepFraction: placement?.ratio ?? 0.5,
					cwd: spec.cwd,
					...(spec.exactName ? { label: spec.exactName } : undefined),
				});
				if (!split.ok) throw new Error(`Could not split a pane for ${spec.role}: ${split.message}`);
				paneId = split.value.paneId;
				if (disposed || spec.signal?.aborted) {
					// Disposal or cancellation may start while a split is in flight; close the late
					// pane here instead of letting it escape the snapshot dispose already took.
					try {
						await backend.closePane(paneId);
					} catch {
						/* best effort */
					}
					throw disposed ? new Error("The agent host is disposed.") : new StartCancelledError();
				}
				ownedPanes.add(paneId);
			}
			// Reserve before startup: failed or concurrent starts cannot reuse this pane.
			panes.push(paneId);
			return paneId;
		});
		allocation = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const removeExchangeDir = async (): Promise<void> => {
		if (!ownsExchangeDir) return;
		await rm(exchangeDir, { recursive: true, force: true });
	};

	return {
		backend: backend.kind,
		tabId: base.tabId,
		exchangeDir,
		async start(spec) {
			if (disposed) return { ok: false, error: "The agent host is disposed." };
			if (spec.signal?.aborted) return { ok: false, error: `Cancelled before starting ${spec.role}.`, aborted: true };
			if (spec.exactName !== undefined && !isValidAgentName(spec.exactName)) {
				return { ok: false, error: `Invalid agent name ${JSON.stringify(spec.exactName)}.` };
			}
			const startupTimeoutMs = spec.startupTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
			if (
				!Number.isSafeInteger(startupTimeoutMs) ||
				startupTimeoutMs < START_TIMEOUT_MIN_MS ||
				startupTimeoutMs > START_TIMEOUT_MAX_MS
			) {
				return {
					ok: false,
					error: `startup timeout must be an integer from ${START_TIMEOUT_MIN_MS} to ${START_TIMEOUT_MAX_MS} ms.`,
				};
			}
			let paneId: string;
			try {
				paneId = await allocatePane(spec);
			} catch (error) {
				if (error instanceof StartCancelledError)
					return { ok: false, error: `Cancelled before starting ${spec.role}.`, aborted: true };
				return { ok: false, error: errorText(error) };
			}
			let name: string | undefined;
			const failure = (error: string, aborted = false): StartFailure => ({
				ok: false,
				error,
				paneId,
				...(name ? { name } : undefined),
				...(aborted ? { aborted } : undefined),
			});
			/** Disposal or cancellation between launch steps ends the start. */
			const interrupted = (): StartFailure | undefined => {
				if (disposed) return failure("The agent host is disposed.");
				if (spec.signal?.aborted) return failure(`Cancelled before starting ${spec.role}.`, true);
				return undefined;
			};
			try {
				const piArgs = hostedAgentArgs(spec, backend.extraPiArgs());
				const attempts = spec.exactName === undefined ? 3 : 1;
				let lastMessage: string | undefined;
				for (let attempt = 0; attempt < attempts; attempt++) {
					const stopped = interrupted();
					if (stopped) return stopped;
					const attemptName = spec.exactName ?? randomAgentName(options.owner, spec.role);
					name = attemptName;
					const stateFile = spec.stateFile ?? join(exchangeDir, "agents", `${attemptName}.json`);
					const launch = () =>
						backend.launchAgent({
							name: attemptName,
							paneId,
							cwd: spec.cwd,
							piArgs,
							stateFile,
							timeoutMs: startupTimeoutMs,
							...(spec.signal ? { signal: spec.signal } : undefined),
						});
					let started: Outcome<AgentSnapshot> = await launch();
					// New panes can precede the shell prompt. Only pane_busy proves no agent was launched.
					for (let retry = 0; !started.ok && started.code === "pane_busy" && retry < PANE_BUSY_RETRIES; retry++) {
						await clock.sleep(PANE_BUSY_RETRY_DELAY_MS);
						const stoppedRetry = interrupted();
						if (stoppedRetry) return stoppedRetry;
						started = await launch();
					}
					if (spec.signal?.aborted) return failure(`Cancelled while starting ${spec.role}.`, true);
					if (started.ok) {
						if (!sameCwd(started.value.cwd, spec.cwd))
							return failure(
								`${backendLabel(backend.kind)} started ${spec.role} with a missing or unexpected cwd; expected ${spec.cwd}. No task was sent.`,
							);
						const agent = new HostedAgentImpl(
							{
								ref: { name: started.value.name || attemptName, paneId, stateFile },
								role: spec.role,
								cwd: spec.cwd,
								tabId: base.tabId,
								...(started.value.sessionFile ? { sessionFile: started.value.sessionFile } : undefined),
								abortPolicy: "owned",
							},
							backend,
							clock,
						);
						if (disposed) {
							await agent.dispose();
							return failure("The agent host is disposed.");
						}
						agents.push(agent);
						return { ok: true, agent };
					}
					lastMessage = started.message;
					if (started.code !== "name_conflict") {
						return failure(
							`Could not start ${spec.role} in pane ${paneId}: ${started.message} (${started.code}). Answer any prompt in that pane — typically a project-trust prompt — then retry.`,
						);
					}
				}
				if (spec.exactName !== undefined) {
					return failure(`Could not start ${spec.role}: the agent name ${spec.exactName} is already in use.`);
				}
				return failure(
					`Could not start ${spec.role}: agent name conflicts persisted after 3 attempts (${lastMessage ?? "unknown"}).`,
				);
			} finally {
				// Readiness failures can leave a live process too. Cancellation owns
				// the allocated pane regardless of whether the backend returned an agent.
				if (spec.signal?.aborted) {
					try {
						const closed = await backend.closePane(paneId);
						if (closed.ok) ownedPanes.delete(paneId);
					} catch {
						/* cleanup is best effort */
					}
				}
			}
		},
		async dispose(disposeOptions) {
			if (disposed) return;
			disposed = true;
			// Wait for in-flight pane allocations so their late panes are closed here,
			// not left behind after dispose snapshots ownedPanes.
			await allocation;
			await Promise.all(agents.map((agent) => agent.dispose()));
			if (disposeOptions?.closeUnassignedPanes && !disposeOptions.closeTab) {
				for (const paneId of [...ownedPanes].filter((pane) => !panes.includes(pane)).reverse()) {
					try {
						const closed = await backend.closePane(paneId);
						if (closed.ok) ownedPanes.delete(paneId);
					} catch {
						/* best effort */
					}
				}
			}
			if (disposeOptions?.closeTab) {
				if (base.kind === "tab") {
					try {
						await backend.closeTab(base.tabId);
					} catch {
						/* dispose is best effort */
					}
				} else {
					// The caller's tab owns these panes; close only what this host split off.
					for (const paneId of [...ownedPanes].reverse()) {
						try {
							await backend.closePane(paneId);
						} catch {
							/* best effort */
						}
					}
				}
			}
			if (!agents.some((agent) => agent.hasAskInFlight())) {
				try {
					await removeExchangeDir();
				} catch {
					/* best effort */
				}
			}
		},
	};
}

async function createExchangeDir(): Promise<string> {
	// fs.mkdtemp creates the directory with mode 0700 on POSIX systems.
	return mkdtemp(join(tmpdir(), "kstack-hosted-"));
}
