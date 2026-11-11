/** Rex implementation of the {@link TerminalBackend} port.
 *
 * Spike results verified in a disposable Rex window on Rex `0.1.0-preview.14`
 * (API revision 12) and Pi `1.5.2`:
 * 1. Bracketed-paste (`\x1b[200~…\x1b[201~`) via `rex send` followed 50 ms later
 *    by `rex send-key enter` submits a multi-line pointer prompt to Pi as one
 *    user message.
 * 2. Pi's OSC 7501 `program_status` reports `idle` at startup, `working` → `done`
 *    across a run, `idle` after Escape aborts a run, and `blocked` (e.g.
 *    `kind: "permission"`) while an interactive dialog is open. Note that Pi
 *    emits an initial `idle` before `session_start` finishes, so readiness
 *    requires both `idle`/`done` and the sidecar's `sessionFile`.
 * 3. `rex send-key … escape` sends `0x1b`; `rex send-key … ctrl+c ctrl+c` in one
 *    call lands within Pi's 500 ms double-Ctrl+C window, exits Pi to the shell,
 *    and clears Pi's `program_status` record (`records: []`).
 * 4. Block labels (`--label`, `rex block rename`) live on `.block.label` and
 *    survive terminal OSC title updates.
 * 5. Launcher input sent right after `rex split` is queued by the PTY and runs
 *    once the interactive shell reaches its prompt.
 * 6. `rex split --ratio PCT` sets the *new* block's 1–99% share (`round((1-F)*100)`).
 *    `rex window new --focus=false` preserves the caller's active window; unowned
 *    background blocks report `owner: null` (`80x24`) until viewed, so geometry
 *    falls back to the caller block's owned dimensions when `owner === null`.
 * 7. Rex CLI exit codes: `0` ok, `2` bad flags/syntax, `3` target not found,
 *    `4` server unreachable.
 */

import { accessSync, constants } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import {
	type HostedAgentState,
	KSTACK_HOSTED_AGENT_NAME_ENV,
	KSTACK_HOSTED_AGENT_STATE_ENV,
	readHostedAgentState,
} from "../agent-state.ts";
import { type Clock, systemClock } from "../clock.ts";
import {
	type AgentRef,
	type AgentSnapshot,
	type AgentStatus,
	type BackendExec,
	type ExecOptions,
	isSettledStatus,
	type Outcome,
	type TerminalBackend,
} from "../terminal-backend.ts";
import {
	createNodeRexExec,
	createRexCli,
	type RexBlockProcess,
	type RexKeyName,
	type RexProgramStatusRecord,
} from "./rex-cli.ts";

const MIN_REX_API_REVISION = 12;
const CONTROL_TIMEOUT_MS = 15_000;
const STALL_WINDOW_MS = 5_000;
const PASTE_ENTER_DELAY_MS = 50;
const LAUNCH_FAILURE_CAPTURE_LINES = 40;
const STALL_CAPTURE_LINES = 30;
/** Poll after 250 ms, then 500 ms, then every second. */
const POLL_FIRST_MS = 250;
const POLL_MAX_MS = 1_000;

const KNOWN_SHELLS = new Set([
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
	"ksh",
	"mksh",
	"tcsh",
	"csh",
	"nu",
	"elvish",
	"pwsh",
]);

const RFC3339_NANO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

interface RexBackendOptions {
	exec?: BackendExec;
	env?: NodeJS.ProcessEnv;
	clock?: Clock;
	resolvePiBinary?: (env: NodeJS.ProcessEnv) => string | undefined;
	/** Allow preflight when `$REX_BLOCK` runs a shell instead of Pi (opt-in e2e script only). */
	allowShellCaller?: boolean;
}

/** Convert Kstack's `keepFraction` (source pane share in `(0,1)`) to Rex's 1–99 new-block percentage. */
export function rexSplitRatioPercent(keepFraction: number): number {
	const raw = Math.round((1 - keepFraction) * 100);
	return Math.min(99, Math.max(1, raw));
}

export function rexSplitDirection(direction: "right" | "down"): "right" | "below" {
	return direction === "down" ? "below" : "right";
}

export function normalizeRexAgentStatus(raw: string): AgentStatus {
	if (raw === "idle" || raw === "working" || raw === "blocked" || raw === "done" || raw === "error") {
		return raw;
	}
	return "unknown";
}

function parseRfc3339Nanos(timestamp: string): bigint | undefined {
	const match = RFC3339_NANO_RE.exec(timestamp.trim());
	if (!match) return undefined;
	const [, dateTime, fraction, zone] = match;
	const wholeMs = Date.parse(`${dateTime}${zone}`);
	if (!Number.isFinite(wholeMs)) return undefined;
	const nanos = BigInt((fraction ?? "").padEnd(9, "0"));
	return BigInt(wholeMs) * 1_000_000n + nanos;
}

/** Compare two Rex RFC 3339 timestamps with full nanosecond precision across timezones. */
export function isUpdatedAfterBaseline(updatedAt: string, baseline: string): boolean {
	if (updatedAt === baseline) return false;
	const currentNanos = parseRfc3339Nanos(updatedAt);
	const baselineNanos = parseRfc3339Nanos(baseline);
	if (currentNanos !== undefined && baselineNanos !== undefined) {
		return currentNanos > baselineNanos;
	}
	const currentMs = Date.parse(updatedAt);
	const baselineMs = Date.parse(baseline);
	if (Number.isFinite(currentMs) && Number.isFinite(baselineMs)) {
		return currentMs >= baselineMs;
	}
	return true;
}

function isInteractiveShell(processName: string | undefined): boolean {
	if (!processName) return false;
	const normalized = processName.replace(/^-/, "").toLowerCase();
	return KNOWN_SHELLS.has(normalized);
}

function findPiRecord(records: readonly RexProgramStatusRecord[]): RexProgramStatusRecord | undefined {
	return records.find((record) => record.app === "pi" || record.effectiveApp === "pi");
}

function processContainsPid(proc: RexBlockProcess, pid: number): boolean {
	return proc.foreground?.pid === pid || proc.ancestors.some((entry) => entry.pid === pid);
}

/** What one Rex block proves about the hosted agent that should own it. */
interface BlockFacts {
	windowId: string;
	label: string;
	proc: RexBlockProcess;
	piRecord: RexProgramStatusRecord | undefined;
}

type BlockIdentity =
	/** An interactive shell with no Pi status record: the agent is gone. */
	| { kind: "absent" }
	/** Some process without Pi owner evidence. */
	| { kind: "unowned" }
	/** Pi is blocked at a startup dialog before writing its sidecar. */
	| { kind: "startup_blocked" }
	| { kind: "no_sidecar" }
	| { kind: "mismatch" }
	| { kind: "verified"; snapshot: AgentSnapshot; recordUpdatedAt: string };

/**
 * Verify a block against its sidecar. A sidecar with a session file must name
 * the Pi status owner; before `session_start` writes the session file, only a
 * blocked startup dialog in the launcher's process tree is accepted.
 */
function classifyBlock(facts: BlockFacts, sidecar: HostedAgentState | undefined, ref: AgentRef): BlockIdentity {
	const { proc, piRecord } = facts;
	if (!piRecord) return isInteractiveShell(proc.foreground?.name) ? { kind: "absent" } : { kind: "unowned" };
	const owner = piRecord.owner;
	if (!owner) return { kind: "unowned" };
	const blockedStartup = piRecord.state === "blocked" && processContainsPid(proc, owner.pid);
	if (!sidecar) return blockedStartup ? { kind: "startup_blocked" } : { kind: "no_sidecar" };
	const identityOk = sidecar.sessionFile
		? owner.pid === sidecar.pid && processContainsPid(proc, sidecar.pid)
		: blockedStartup && (sidecar.pid === owner.pid || processContainsPid(proc, sidecar.pid));
	if (!identityOk) return { kind: "mismatch" };
	const foreground = proc.foreground;
	const cwd = foreground?.pid === sidecar.pid && foreground.cwd ? foreground.cwd : sidecar.cwd;
	return {
		kind: "verified",
		snapshot: {
			name: sidecar.name || facts.label || ref.name,
			paneId: ref.paneId,
			tabId: facts.windowId,
			status: normalizeRexAgentStatus(piRecord.state),
			cwd,
			...(sidecar.sessionFile ? { sessionFile: sidecar.sessionFile } : undefined),
		},
		recordUpdatedAt: piRecord.updatedAt,
	};
}

function unverifiedMessage(identity: Exclude<BlockIdentity, { kind: "absent" | "verified" }>, ref: AgentRef): string {
	switch (identity.kind) {
		case "unowned":
			return `Cannot verify the live process in Rex block ${ref.paneId}; inspect the pane before retrying.`;
		case "startup_blocked":
		case "no_sidecar":
			return `Hosted agent state file is missing or unreadable for ${ref.name}; inspect pane ${ref.paneId} and restore its state file before retrying.`;
		case "mismatch":
			return `Process identity in Rex block ${ref.paneId} does not match ${ref.name}; inspect the pane before retrying.`;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function defaultResolvePiBinary(env: NodeJS.ProcessEnv): string | undefined {
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		if (!entry) continue;
		const candidate = join(entry, "pi");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* try next PATH entry */
		}
	}
	return undefined;
}

function buildLauncherScript(options: {
	name: string;
	cwd: string;
	stateFile: string;
	piBinary: string;
	piArgs: readonly string[];
}): string {
	const initTemp = `${options.stateFile}.init.tmp`;
	const quotedArgs = [options.piBinary, ...options.piArgs].map(shellQuote).join(" ");
	return [
		"#!/bin/sh",
		`export ${KSTACK_HOSTED_AGENT_STATE_ENV}=${shellQuote(options.stateFile)}`,
		`export ${KSTACK_HOSTED_AGENT_NAME_ENV}=${shellQuote(options.name)}`,
		`printf '{"version":1,"name":%s,"pid":%s,"cwd":%s,"updatedAt":"%s"}\\n' ${shellQuote(JSON.stringify(options.name))} "$$" ${shellQuote(JSON.stringify(options.cwd))} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${shellQuote(initTemp)} && chmod 600 ${shellQuote(initTemp)} && mv ${shellQuote(initTemp)} ${shellQuote(options.stateFile)}`,
		`exec ${quotedArgs}`,
		"",
	].join("\n");
}

function tailLines(text: string, maxLines: number): string {
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line, index, all) => index < all.length - 1 || line.length > 0);
	return lines.slice(-maxLines).join("\n");
}

/** Whether the prompt's first line already sits in Pi's editor, even when the editor wrapped it. */
function editorShowsPrompt(captured: string, text: string): boolean {
	const squash = (value: string) => value.replace(/\s+/g, "");
	const firstLine = squash(text.split("\n")[0] ?? "");
	return firstLine.length > 0 && squash(tailLines(captured, STALL_CAPTURE_LINES)).includes(firstLine);
}

export function createRexBackend(options: RexBackendOptions = {}): TerminalBackend {
	const env = options.env ?? process.env;
	const cli = createRexCli(options.exec ?? createNodeRexExec(env));
	const clock = options.clock ?? systemClock;
	const resolvePi = options.resolvePiBinary ?? defaultResolvePiBinary;
	const lastStalledPromptByPane = new Map<string, string>();
	const sessionId = env.REX_SESSION?.trim() ?? "";
	const callerBlock = env.REX_BLOCK?.trim() ?? "";

	const runOpts = (signal?: AbortSignal, timeoutMs = CONTROL_TIMEOUT_MS): ExecOptions => ({
		timeoutMs,
		...(signal ? { signal } : undefined),
	});
	const block = (blockId: string) => ({ sessionId, blockId });
	const aborted = (message: string) => ({ ok: false, code: "aborted", message }) as const;

	const readBlock = async (blockId: string, signal?: AbortSignal): Promise<Outcome<BlockFacts>> => {
		const [inspected, proc, status] = await Promise.all([
			cli.blockInspect(block(blockId), runOpts(signal)),
			cli.blockProcess(block(blockId), runOpts(signal)),
			cli.blockProgramStatus(block(blockId), runOpts(signal)),
		]);
		if (!inspected.ok) return inspected;
		if (!proc.ok) return proc;
		if (!status.ok) return status;
		return {
			ok: true,
			value: {
				windowId: inspected.value.windowId,
				label: inspected.value.label,
				proc: proc.value,
				piRecord: findPiRecord(status.value.records),
			},
		};
	};

	/** Poll with backoff until `attempt` settles, the signal aborts, or the deadline passes (`undefined`). */
	const pollUntil = async <T>(
		deadline: number,
		signal: AbortSignal | undefined,
		cancelledMessage: string,
		attempt: () => Promise<Outcome<T> | undefined>,
		boundary: () => number = () => deadline,
	): Promise<Outcome<T> | undefined> => {
		for (let step = 0; clock.now() < deadline; step++) {
			if (signal?.aborted) return aborted(cancelledMessage);
			const stepMs = Math.min(POLL_FIRST_MS * 2 ** step, POLL_MAX_MS);
			await clock.sleep(Math.min(stepMs, Math.max(1, Math.min(boundary(), deadline) - clock.now())), signal);
			if (signal?.aborted) return aborted(cancelledMessage);
			const result = await attempt();
			if (result) return result;
		}
		return undefined;
	};

	const readVerifiedAgent = async (
		ref: AgentRef,
		signal?: AbortSignal,
	): Promise<Outcome<{ snapshot: AgentSnapshot; recordUpdatedAt: string }>> => {
		const { stateFile } = ref;
		if (!stateFile) {
			return { ok: false, code: "identity_unverified", message: `Agent ${ref.name} has no recorded state file.` };
		}
		const facts = await readBlock(ref.paneId, signal);
		if (!facts.ok) return facts;
		const identity = classifyBlock(facts.value, readHostedAgentState(stateFile), ref);
		if (identity.kind === "verified") return { ok: true, value: identity };
		if (identity.kind === "absent") {
			return { ok: false, code: "not_found", message: `No live Pi agent in Rex block ${ref.paneId}.` };
		}
		return { ok: false, code: "identity_unverified", message: unverifiedMessage(identity, ref) };
	};

	/** Live Pi blocks labelled `name`. Blocks that vanish mid-scan are skipped; other probe failures fail the scan. */
	const findAgentsNamed = async (name: string, signal?: AbortSignal): Promise<Outcome<AgentSnapshot[]>> => {
		const listed = await cli.blockList({ sessionId }, runOpts(signal));
		if (!listed.ok) return listed;
		const labelled = listed.value.filter((entry) => entry.label === name);
		const observed = await Promise.all(
			labelled.map(async ({ blockId }) => ({ blockId, facts: await readBlock(blockId, signal) })),
		);
		const matches: AgentSnapshot[] = [];
		for (const { blockId, facts } of observed) {
			if (!facts.ok) {
				if (facts.code === "not_found") continue;
				return facts;
			}
			const { piRecord, proc, windowId } = facts.value;
			if (!piRecord?.owner || !processContainsPid(proc, piRecord.owner.pid)) continue;
			const cwd = proc.foreground?.cwd;
			matches.push({
				name,
				paneId: blockId,
				tabId: windowId,
				status: normalizeRexAgentStatus(piRecord.state),
				...(cwd ? { cwd } : undefined),
			});
		}
		return { ok: true, value: matches };
	};

	return {
		kind: "rex",
		extraPiArgs(): string[] {
			return [];
		},
		async preflight() {
			if (!sessionId || !callerBlock) {
				return { ok: false, error: "Rex environment variables REX_SESSION and REX_BLOCK are missing." };
			}
			const who = await cli.whoami({ timeoutMs: 5_000 });
			if (!who.ok) return { ok: false, error: `Rex is not reachable: ${who.message}` };
			if (who.value.apiRevision < MIN_REX_API_REVISION) {
				return {
					ok: false,
					error: `Rex API revision ${MIN_REX_API_REVISION} or newer is required (got ${who.value.apiRevision}).`,
				};
			}
			if (who.value.sessionId !== sessionId || who.value.blockId !== callerBlock) {
				return {
					ok: false,
					error: `Rex caller block ${callerBlock} in session ${sessionId} was not found on the connected server.`,
				};
			}
			const inspected = await cli.blockInspect(block(callerBlock), { timeoutMs: 5_000 });
			if (!inspected.ok) return { ok: false, error: `Could not inspect the caller's Rex block: ${inspected.message}` };
			if (!inspected.value.methods.includes("program_status")) {
				return { ok: false, error: "The caller's Rex block does not support program_status." };
			}
			if (!options.allowShellCaller) {
				const callerStatus = await cli.blockProgramStatus(block(callerBlock), { timeoutMs: 5_000 });
				if (!callerStatus.ok) {
					return { ok: false, error: `Could not read the caller's Rex program_status: ${callerStatus.message}` };
				}
				if (!findPiRecord(callerStatus.value.records)) {
					return {
						ok: false,
						error: "The caller's Rex block has no Pi program_status record. Run from a Pi version that emits OSC 7501.",
					};
				}
			}
			return { ok: true, caller: { paneId: callerBlock, tabId: inspected.value.windowId } };
		},
		async createTab(tabOptions) {
			const created = await cli.windowNew({ sessionId, label: tabOptions.label, cwd: tabOptions.cwd }, runOpts());
			if (!created.ok) return created;
			return { ok: true, value: { tabId: created.value.windowId, rootPaneId: created.value.rootBlockId } };
		},
		async splitPane(splitOptions) {
			const split = await cli.split(
				{
					sessionId,
					blockId: splitOptions.paneId,
					direction: rexSplitDirection(splitOptions.direction),
					ratioPercent: rexSplitRatioPercent(splitOptions.keepFraction),
					...(splitOptions.cwd ? { cwd: splitOptions.cwd } : undefined),
					...(splitOptions.label ? { label: splitOptions.label } : undefined),
				},
				runOpts(),
			);
			if (!split.ok) return split;
			const inspected = await cli.blockInspect(block(split.value.blockId), runOpts());
			if (!inspected.ok) return inspected;
			return { ok: true, value: { paneId: split.value.blockId, tabId: inspected.value.windowId } };
		},
		async paneGeometry(paneId) {
			const [inspected, size] = await Promise.all([
				cli.blockInspect(block(paneId), runOpts()),
				cli.blockSize(block(paneId), runOpts()),
			]);
			if (!inspected.ok) return inspected;
			if (!size.ok) return size;
			let widthColumns = size.value.columns;
			let heightRows = size.value.rows;
			if (size.value.owner === null && callerBlock && paneId !== callerBlock) {
				const callerSize = await cli.blockSize(block(callerBlock), runOpts());
				if (callerSize.ok && callerSize.value.owner !== null) {
					widthColumns = callerSize.value.columns;
					heightRows = callerSize.value.rows;
				}
			}
			return { ok: true, value: { widthColumns, heightRows, tabId: inspected.value.windowId } };
		},
		async closePane(paneId) {
			if (paneId === callerBlock) {
				return { ok: false, code: "protocol_error", message: "Refusing to close the caller's own Rex block." };
			}
			lastStalledPromptByPane.delete(paneId);
			return cli.blockClose(block(paneId), runOpts());
		},
		async closeTab(tabId) {
			return cli.windowClose({ sessionId, windowId: tabId }, runOpts());
		},
		async launchAgent(launchOptions) {
			const { name, paneId, cwd, piArgs, stateFile, timeoutMs, signal } = launchOptions;
			if (paneId === callerBlock) {
				return { ok: false, code: "protocol_error", message: "Refusing to launch an agent in the caller's Rex block." };
			}
			if (signal?.aborted) return aborted(`Cancelled before launching ${name}.`);

			const conflicts = await findAgentsNamed(name, signal);
			if (!conflicts.ok) return conflicts;
			if (conflicts.value.some((existing) => existing.paneId !== paneId)) {
				return { ok: false, code: "name_conflict", message: `agent name ${name} already in use` };
			}

			const initial = await readBlock(paneId, signal);
			if (!initial.ok) return initial;
			if (classifyBlock(initial.value, undefined, { name, paneId }).kind !== "absent") {
				return {
					ok: false,
					code: "pane_busy",
					message: `Rex block ${paneId} is not at an idle interactive shell prompt.`,
				};
			}

			const piBinary = resolvePi(env);
			if (!piBinary) {
				return { ok: false, code: "unavailable", message: "Could not locate an executable `pi` binary on PATH." };
			}

			const launcherPath = `${stateFile}.launch`;
			await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
			await rm(stateFile, { force: true });
			await writeFile(launcherPath, buildLauncherScript({ name, cwd, stateFile, piBinary, piArgs }), { mode: 0o700 });
			await chmod(launcherPath, 0o700);

			try {
				const renamed = await cli.blockRename({ ...block(paneId), label: name }, runOpts(signal));
				if (!renamed.ok) return renamed;
				const sent = await cli.send({ ...block(paneId), text: ` ${shellQuote(launcherPath)}` }, runOpts(signal));
				if (!sent.ok) return sent;
				const entered = await cli.sendKeys({ ...block(paneId), keys: ["enter"] }, runOpts(signal));
				if (!entered.ok) return entered;

				let leftShell = false;
				const ready = await pollUntil(
					clock.now() + timeoutMs,
					signal,
					`Cancelled while starting ${name}.`,
					async () => {
						const facts = await readBlock(paneId, signal);
						if (!facts.ok) return facts;
						const sidecar = readHostedAgentState(stateFile);
						const identity = classifyBlock(facts.value, sidecar, { name, paneId, stateFile });
						if (identity.kind === "verified") {
							const { snapshot } = identity;
							if (snapshot.sessionFile && (snapshot.status === "idle" || snapshot.status === "done")) {
								return { ok: true, value: { ...snapshot, name } };
							}
						}
						if (
							identity.kind === "startup_blocked" ||
							(identity.kind === "verified" && identity.snapshot.status === "blocked")
						) {
							return {
								ok: false,
								code: "agent_blocked",
								message: `Agent ${name} is waiting at a startup prompt in ${paneId}.`,
							};
						}
						if (identity.kind !== "absent") {
							leftShell = true;
							return undefined;
						}
						if (!leftShell && !sidecar) return undefined;
						const captured = await cli.capture({ ...block(paneId), trim: true, unwrap: true }, runOpts(signal));
						const excerpt = captured.ok ? tailLines(captured.value, LAUNCH_FAILURE_CAPTURE_LINES) : "";
						return {
							ok: false,
							code: "protocol_error",
							message: excerpt
								? `Pi exited during startup in ${paneId}:\n${excerpt}`
								: `Pi exited during startup in ${paneId}.`,
						};
					},
				);
				return (
					ready ?? {
						ok: false,
						code: "timeout",
						message: `Timed out after ${timeoutMs} ms waiting for ${name} to become ready in ${paneId}.`,
					}
				);
			} finally {
				await rm(launcherPath, { force: true }).catch(() => {});
			}
		},
		async getAgent(ref) {
			const verified = await readVerifiedAgent(ref);
			if (!verified.ok) return verified;
			return { ok: true, value: verified.value.snapshot };
		},
		async findAgentsNamed(name) {
			return findAgentsNamed(name);
		},
		async prompt(ref, text, promptOptions) {
			const { timeoutMs, signal } = promptOptions;
			if (ref.paneId === callerBlock) {
				return { ok: false, code: "protocol_error", message: "Refusing to prompt the caller's own Rex block." };
			}
			const initial = await readVerifiedAgent(ref, signal);
			if (!initial.ok) return initial;
			if (initial.value.snapshot.status === "blocked") {
				return { ok: false, code: "agent_blocked", message: `Agent ${ref.name} is blocked at a prompt.` };
			}
			const baseline = initial.value.recordUpdatedAt;

			let onlySendEnter = false;
			if (lastStalledPromptByPane.get(ref.paneId) === text) {
				const captured = await cli.capture({ ...block(ref.paneId), trim: true, unwrap: true }, runOpts(signal));
				onlySendEnter = captured.ok && editorShowsPrompt(captured.value, text);
			}
			if (!onlySendEnter) {
				const modes = await cli.blockModes(block(ref.paneId), runOpts(signal));
				if (!modes.ok) return modes;
				const payload = modes.value.bracketedPaste ? `\u001b[200~${text}\u001b[201~` : text;
				const sent = await cli.send({ ...block(ref.paneId), text: payload }, runOpts(signal));
				if (!sent.ok) return sent;
				await clock.sleep(PASTE_ENTER_DELAY_MS, signal);
				if (signal?.aborted) return aborted("Prompt cancelled.");
			}
			const entered = await cli.sendKeys({ ...block(ref.paneId), keys: ["enter"] }, runOpts(signal));
			if (!entered.ok) return entered;

			const startedAt = clock.now();
			const stallDeadline = startedAt + Math.min(STALL_WINDOW_MS, timeoutMs);
			let sawProgress = false;
			const settled = await pollUntil(
				startedAt + timeoutMs,
				signal,
				"Prompt cancelled.",
				async () => {
					const verified = await readVerifiedAgent(ref, signal);
					if (!verified.ok) return verified;
					const { snapshot, recordUpdatedAt } = verified.value;
					if (snapshot.status === "working" || isUpdatedAfterBaseline(recordUpdatedAt, baseline)) {
						sawProgress = true;
						lastStalledPromptByPane.delete(ref.paneId);
					}
					if (sawProgress && (isSettledStatus(snapshot.status) || snapshot.status === "blocked")) {
						return { ok: true, value: snapshot };
					}
					if (!sawProgress && clock.now() >= stallDeadline) {
						lastStalledPromptByPane.set(ref.paneId, text);
						return {
							ok: false,
							code: "prompt_stalled",
							message: `No status change observed within ${STALL_WINDOW_MS} ms in ${ref.paneId}.`,
						};
					}
					return undefined;
				},
				() => (sawProgress ? Number.POSITIVE_INFINITY : stallDeadline),
			);
			return (
				settled ?? {
					ok: false,
					code: "timeout",
					message: `Timed out after ${timeoutMs} ms waiting for ${ref.name} to finish.`,
				}
			);
		},
		async waitSettled(ref, waitOptions) {
			const { timeoutMs, signal } = waitOptions;
			let sawWorking = false;
			const check = async (): Promise<Outcome<AgentSnapshot> | undefined> => {
				const verified = await readVerifiedAgent(ref, signal);
				if (!verified.ok) return verified;
				const { snapshot } = verified.value;
				if (isSettledStatus(snapshot.status) || (sawWorking && snapshot.status === "blocked")) {
					return { ok: true, value: snapshot };
				}
				if (snapshot.status === "working") sawWorking = true;
				return undefined;
			};
			const deadline = clock.now() + timeoutMs;
			if (signal?.aborted) return aborted("Wait cancelled.");
			const settled = (await check()) ?? (await pollUntil(deadline, signal, "Wait cancelled.", check));
			return (
				settled ?? {
					ok: false,
					code: "timeout",
					message: `Timed out after ${timeoutMs} ms waiting for ${ref.name} to settle.`,
				}
			);
		},
		async sendKeys(ref, keys) {
			if (ref.paneId === callerBlock) {
				return {
					ok: false,
					code: "protocol_error",
					message: "Refusing to send control keys to the caller's own Rex block.",
				};
			}
			const mapped: RexKeyName[] = keys.map((key) => (key === "esc" ? "escape" : "ctrl+c"));
			return cli.sendKeys({ ...block(ref.paneId), keys: mapped }, runOpts());
		},
	};
}
