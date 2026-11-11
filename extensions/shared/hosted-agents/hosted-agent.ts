/** Request lifecycle for one hosted Pi agent: ask, resume, abort, and dispose.
 *
 * A short pointer prompt crosses the terminal; instructions and answers cross
 * as 0600 files. The validated answer comes from Pi's session JSONL.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type BoundaryValue, isObject } from "../validation.ts";
import { isValidAgentName } from "./agent-spec.ts";
import type { TerminalSession } from "./backends.ts";
import { type Clock, systemClock } from "./clock.ts";
import { sameCwd } from "./cwd.ts";
import { readResponse, responseMarker } from "./response.ts";
import { emptyUsage, readUsageSince, type UsageSummary, usageOffset } from "./session-usage.ts";
import {
	type AgentRef,
	type AgentSnapshot,
	type BackendFailure,
	backendLabel,
	isSettledStatus,
	type TerminalBackend,
} from "./terminal-backend.ts";

export interface AskOptions {
	/** 0600 instructions file the host or caller wrote. */
	promptFile: string;
	/** Where the host materializes the validated final response. */
	outputFile: string;
	/** 1..60 minutes. */
	timeoutMs: number;
	/** Default 256 KiB; output is truncated with a marker beyond the cap. */
	outputCapBytes?: number;
	signal?: AbortSignal;
}

/* exported: hosted-agent interface contract consumed by the council skill and fanout adapters */
export type AskResult =
	| { status: "completed"; output: string; usage: UsageSummary; session?: string }
	| { status: "blocked"; paneId: string; usage: UsageSummary }
	| { status: "failed"; error: string; usage: UsageSummary; stderr?: string }
	| { status: "aborted"; usage: UsageSummary };

export interface HostedAgent {
	readonly name: string;
	readonly role: string;
	readonly paneId: string;
	readonly tabId: string;
	readonly sessionFile: string | undefined;
	/** One ask in flight; a second concurrent call rejects. */
	ask(options: AskOptions): Promise<AskResult>;
	/** Resume the stored blocked request, delivering it if it was rejected before send. */
	resume(): Promise<AskResult>;
	/** Cancel by ownership policy: owned agents escalate through Ctrl+C and pane close; attached agents receive Escape only. */
	abort(): Promise<void>;
	dispose(options?: { closePane?: boolean }): Promise<void>;
}

const ASK_TIMEOUT_MIN_MS = 60_000;
const ASK_TIMEOUT_MAX_MS = 3_600_000;
const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;
const OUTPUT_CAP_MAX_BYTES = 4 * 1024 * 1024;
export const POINTER_PROMPT_MAX_BYTES = 512;
const STALLED_RETRY_DELAY_MS = 2_000;

/** The fixed pointer prompt sent through the terminal; instructions stay in files. */
export function pointerPrompt(promptFile: string, requestId: string): string {
	return (
		`Read and follow the instructions in ${promptFile}. ` +
		`Return your complete answer in your final reply, starting with the exact line ${responseMarker(requestId)}\n` +
		`The host saves your response; do not write an answer file.`
	);
}

function emptyFailed(error: string): AskResult {
	return { status: "failed", error, usage: emptyUsage() };
}

function validateAskOptions(options: Pick<AskOptions, "timeoutMs" | "outputCapBytes">): string | undefined {
	if (
		!Number.isFinite(options.timeoutMs) ||
		options.timeoutMs < ASK_TIMEOUT_MIN_MS ||
		options.timeoutMs > ASK_TIMEOUT_MAX_MS
	) {
		return `ask timeout must be between ${ASK_TIMEOUT_MIN_MS / 60_000} and ${ASK_TIMEOUT_MAX_MS / 60_000} minutes.`;
	}
	const outputCapBytes = options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
	if (!Number.isSafeInteger(outputCapBytes) || outputCapBytes < 1 || outputCapBytes > OUTPUT_CAP_MAX_BYTES) {
		return `output cap must be an integer from 1 to ${OUTPUT_CAP_MAX_BYTES} bytes.`;
	}
	return undefined;
}

export function errorText(error: BoundaryValue): string {
	return isObject(error) && error instanceof Error ? error.message : String(error);
}

type SendOutcome = { settled: true } | AskResult;

/** `owned`: the host started the agent and may close its pane. `attached`: a skill or the user owns the pane. */
type AbortPolicy = "owned" | "attached";

interface PendingRequest {
	id: string;
	options: AskOptions;
	prompt: string;
	delivered: boolean;
	sessionFile: string | undefined;
	responseOffset: number;
	usageOffset: number;
	cancelled: boolean;
	onAbort: () => void;
}

export class HostedAgentImpl implements HostedAgent {
	readonly role: string;
	readonly tabId: string;
	sessionFile: string | undefined;
	private readonly ref: AgentRef;
	private readonly backend: TerminalBackend;
	private readonly clock: Clock;
	private readonly cwd: string;
	private readonly abortPolicy: AbortPolicy;
	private askBusy = false;
	private abortPromise: Promise<void> | undefined;
	private pending: PendingRequest | undefined;
	private closed = false;

	constructor(
		init: {
			ref: AgentRef;
			role: string;
			cwd: string;
			tabId: string;
			sessionFile?: string;
			abortPolicy: AbortPolicy;
		},
		backend: TerminalBackend,
		clock: Clock = systemClock,
	) {
		this.ref = init.ref;
		this.role = init.role;
		this.cwd = init.cwd;
		this.tabId = init.tabId;
		this.sessionFile = init.sessionFile;
		this.abortPolicy = init.abortPolicy;
		this.backend = backend;
		this.clock = clock;
	}

	get name(): string {
		return this.ref.name;
	}

	get paneId(): string {
		return this.ref.paneId;
	}

	hasAskInFlight(): boolean {
		return this.askBusy || this.pending !== undefined;
	}

	/** Usage is incremental across blocked returns, but starts fresh for every request. */
	private usage(): UsageSummary {
		const request = this.pending;
		if (!this.sessionFile || !request || (request.sessionFile && request.sessionFile !== this.sessionFile))
			return emptyUsage();
		const read = readUsageSince(this.sessionFile, request.usageOffset);
		request.usageOffset = read.nextOffset;
		return read.usage;
	}

	private refreshSession(info: AgentSnapshot | undefined): void {
		if (info?.sessionFile) this.sessionFile = info.sessionFile;
	}

	/** Attached panes stay open on failure, so tell the user where to look. */
	private withPaneHint(error: string): string {
		return this.abortPolicy === "attached" ? `${error} Inspect pane ${this.paneId}; the agent was not closed.` : error;
	}

	async ask(options: AskOptions): Promise<AskResult> {
		if (this.askBusy || this.pending) throw new Error(`Agent ${this.name} already has an ask in flight.`);
		if (this.closed) return emptyFailed(`Agent ${this.name} is closed.`);
		const optionsError = validateAskOptions(options);
		if (optionsError) return emptyFailed(`${this.role}: ${optionsError}`);
		this.askBusy = true;
		try {
			const id = randomUUID();
			const prompt = pointerPrompt(options.promptFile, id);
			if (Buffer.byteLength(prompt, "utf8") > POINTER_PROMPT_MAX_BYTES) {
				return emptyFailed(
					`${this.role}: pointer prompt exceeds ${POINTER_PROMPT_MAX_BYTES} bytes; shorten the instruction path.`,
				);
			}
			const prepared = await this.prepareExchangeFiles(options.promptFile, options.outputFile);
			if (!prepared.ok) return emptyFailed(`${this.role}: ${prepared.error}`);
			const current = await this.backend.getAgent(this.ref);
			if (!current.ok) return emptyFailed(current.message);
			if (!sameCwd(current.value.cwd, this.cwd))
				return emptyFailed(`${this.role}: hosted cwd is missing or differs from the assigned cwd.`);
			// A prompt queued behind a human turn settles when that turn ends, before this request ran.
			if (current.value.status === "working")
				return emptyFailed(`${this.role}: the hosted agent is working on another turn; wait for it to settle.`);
			this.refreshSession(current.value);
			const offset = this.sessionFile ? usageOffset(this.sessionFile) : 0;
			this.abortPromise = undefined;
			const request: PendingRequest = {
				id,
				options: { ...options },
				prompt,
				delivered: false,
				sessionFile: this.sessionFile,
				responseOffset: offset,
				usageOffset: offset,
				cancelled: false,
				onAbort: () => {
					void this.abort();
				},
			};
			this.pending = request;
			options.signal?.addEventListener("abort", request.onAbort, { once: true });
			return await this.runRequest(request, false);
		} finally {
			this.askBusy = false;
		}
	}

	async resume(): Promise<AskResult> {
		if (this.askBusy) throw new Error(`Agent ${this.name} already has an ask in flight.`);
		const request = this.pending;
		if (!request) return emptyFailed(`${this.role}: no blocked request to resume.`);
		this.askBusy = true;
		try {
			return await this.runRequest(request, true);
		} finally {
			this.askBusy = false;
		}
	}

	/** Protect the exchange files and clear stale output before an ask. */
	private async prepareExchangeFiles(
		promptFile: string,
		outputFile: string,
	): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			if (resolve(promptFile) === resolve(outputFile)) throw new Error("Instruction and output paths must differ.");
			await chmod(promptFile, 0o600);
			await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 });
			await writeFile(outputFile, "", { mode: 0o600 });
			await chmod(outputFile, 0o600);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: `could not prepare exchange files: ${errorText(error)}` };
		}
	}

	private async runRequest(request: PendingRequest, resume: boolean): Promise<AskResult> {
		let blocked = false;
		try {
			if (request.cancelled || request.options.signal?.aborted) {
				await this.abort();
				return { status: "aborted", usage: this.usage() };
			}
			let sent: SendOutcome;
			if (resume) {
				sent = await this.waitForSettle(request.options);
				if ("settled" in sent && !request.delivered && !request.cancelled)
					sent = await this.sendPointerPrompt(request.prompt, request.options);
			} else {
				sent = await this.sendPointerPrompt(request.prompt, request.options);
			}
			if (request.cancelled || request.options.signal?.aborted) {
				await this.abort();
				return { status: "aborted", usage: this.usage() };
			}
			if (!("settled" in sent)) {
				blocked = sent.status === "blocked";
				if (sent.status === "failed") await this.abort();
				return sent;
			}
			const result = await this.collectAnswer(request);
			if (request.cancelled || request.options.signal?.aborted) {
				await this.abort();
				await writeFile(request.options.outputFile, "", { mode: 0o600 });
				return { status: "aborted", usage: this.usage() };
			}
			return result;
		} catch (error) {
			const cancelled = request.cancelled || request.options.signal?.aborted;
			await this.abort();
			if (cancelled) return { status: "aborted", usage: this.usage() };
			return { status: "failed", error: this.withPaneHint(`${this.role}: ${errorText(error)}`), usage: this.usage() };
		} finally {
			if (!blocked) {
				request.options.signal?.removeEventListener("abort", request.onAbort);
				this.pending = undefined;
			}
		}
	}

	private observeSettlement(info: AgentSnapshot): SendOutcome {
		this.refreshSession(info);
		if (!sameCwd(info.cwd, this.cwd))
			return { status: "failed", error: "Hosted cwd changed during the request.", usage: this.usage() };
		if (this.pending?.sessionFile && this.sessionFile !== this.pending.sessionFile)
			return { status: "failed", error: "Hosted session changed during the request.", usage: this.usage() };
		if (info.status === "blocked") return { status: "blocked", paneId: this.paneId, usage: this.usage() };
		if (isSettledStatus(info.status)) return { settled: true };
		return {
			status: "failed",
			error: `${backendLabel(this.backend.kind)} returned an unsettled agent (${info.status}).`,
			usage: this.usage(),
		};
	}

	/** Turn a failed prompt or wait into the request outcome shared by both paths. */
	private async failureOutcome(
		failure: BackendFailure,
		options: Pick<AskOptions, "timeoutMs" | "signal">,
	): Promise<SendOutcome> {
		if (options.signal?.aborted || failure.code === "aborted") {
			await this.abort();
			return { status: "aborted", usage: this.usage() };
		}
		if (failure.code === "agent_blocked") return { status: "blocked", paneId: this.paneId, usage: this.usage() };
		if (failure.code === "timeout") {
			const error = this.withPaneHint(`Timed out after ${Math.round(options.timeoutMs / 1000)}s.`);
			return { status: "failed", error, usage: this.usage() };
		}
		return { status: "failed", error: `${failure.code}: ${failure.message}`, usage: this.usage() };
	}

	private async sendPointerPrompt(promptText: string, options: AskOptions): Promise<SendOutcome> {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) await this.clock.sleep(STALLED_RETRY_DELAY_MS);
			if (this.pending?.cancelled || options.signal?.aborted) return { status: "aborted", usage: this.usage() };
			const outcome = await this.backend.prompt(this.ref, promptText, {
				timeoutMs: options.timeoutMs,
				...(options.signal ? { signal: options.signal } : undefined),
			});
			if (outcome.ok) {
				if (this.pending) this.pending.delivered = true;
				return this.observeSettlement(outcome.value);
			}
			if (outcome.code === "prompt_stalled" && !options.signal?.aborted) continue;
			return this.failureOutcome(outcome, options);
		}
		return {
			status: "failed",
			error: `${this.role}: prompt_stalled twice; the agent never observed the prompt. Inspect pane ${this.paneId}.`,
			usage: this.usage(),
		};
	}

	private async waitForSettle(options: Omit<AskOptions, "promptFile">): Promise<SendOutcome> {
		const outcome = await this.backend.waitSettled(this.ref, {
			timeoutMs: options.timeoutMs,
			...(options.signal ? { signal: options.signal } : undefined),
		});
		if (outcome.ok) return this.observeSettlement(outcome.value);
		return this.failureOutcome(outcome, options);
	}

	private async collectAnswer(request: PendingRequest): Promise<AskResult> {
		if (!this.sessionFile) throw new Error(`${backendLabel(this.backend.kind)} did not report a Pi session file.`);
		if (request.sessionFile && this.sessionFile !== request.sessionFile)
			throw new Error("Hosted session changed during the request; retry in the selected session.");
		const output = await readResponse(
			this.sessionFile,
			request.responseOffset,
			request.id,
			request.options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
		);
		await writeFile(request.options.outputFile, output, { mode: 0o600 });
		return { status: "completed", output, usage: this.usage(), session: this.sessionFile };
	}

	async abort(): Promise<void> {
		if (this.pending) this.pending.cancelled = true;
		this.abortPromise ??= this.runAbort();
		await this.abortPromise;
	}

	private async runAbort(): Promise<void> {
		await this.sendKeys(["esc"]);
		if (await this.settles(2_000)) return;
		if (this.abortPolicy === "attached") {
			// The pane belongs to a skill or the user; report instead of killing Pi.
			return;
		}
		// Pi exits only when both presses arrive within 500 ms; one call keeps them together.
		await this.sendKeys(["ctrl+c", "ctrl+c"]);
		if (await this.settles(2_000)) return;
		this.closed = true;
		try {
			await this.backend.closePane(this.paneId);
		} catch {
			/* abort is best effort */
		}
	}

	private async sendKeys(keys: readonly ("esc" | "ctrl+c")[]): Promise<void> {
		try {
			await this.backend.sendKeys(this.ref, keys);
		} catch {
			/* abort is best effort */
		}
	}

	/** Stop abort escalation once the agent can accept another request, including after an error. */
	private async settles(timeoutMs: number): Promise<boolean> {
		try {
			const outcome = await this.backend.waitSettled(this.ref, { timeoutMs });
			return outcome.ok && isSettledStatus(outcome.value.status);
		} catch {
			return false;
		}
	}

	async dispose(options?: { closePane?: boolean }): Promise<void> {
		if (this.pending) {
			await this.abort();
			this.pending?.options.signal?.removeEventListener("abort", this.pending.onAbort);
			if (!this.askBusy) this.pending = undefined;
		}
		if (options?.closePane) {
			this.closed = true;
			try {
				await this.backend.closePane(this.paneId);
			} catch {
				/* dispose is best effort */
			}
		}
	}
}

/** Use the same request lifecycle for a skill's already-running hosted Pi agent. */
export async function attachHostedAgent(
	ref: AgentRef,
	session: TerminalSession,
	clock: Clock = systemClock,
): Promise<{ ok: true; agent: HostedAgent } | { ok: false; error: string }> {
	if (!isValidAgentName(ref.name)) return { ok: false, error: "Invalid hosted agent name." };
	const { backend, caller } = session;
	if (ref.paneId === caller.paneId) return { ok: false, error: "Cannot ask the caller's own pane." };
	const found = await backend.getAgent(ref);
	if (!found.ok) return { ok: false, error: found.message };
	if (found.value.paneId === caller.paneId) return { ok: false, error: "Cannot ask the caller's own pane." };
	if (!found.value.cwd) return { ok: false, error: `${backendLabel(backend.kind)} did not report the agent cwd.` };
	return {
		ok: true,
		agent: new HostedAgentImpl(
			{
				ref: { ...ref, paneId: found.value.paneId },
				role: ref.name,
				cwd: found.value.cwd,
				tabId: found.value.tabId,
				...(found.value.sessionFile ? { sessionFile: found.value.sessionFile } : undefined),
				abortPolicy: "attached",
			},
			backend,
			clock,
		),
	};
}
