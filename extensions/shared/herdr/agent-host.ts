/** Deep module hosting long-lived Pi agents in Herdr panes.
 *
 * One `AgentHost` owns exactly one Herdr tab in the caller's workspace, lays
 * out agent panes inside it, starts named interactive Pi agents, and talks to
 * them through a file-based ask protocol: a short pointer prompt crosses the
 * terminal, instructions and answers cross as 0600 files in a 0700 exchange
 * directory. The caller's own pane is never split, focused, or closed. Panes
 * are retained by default so the user can keep talking to the agents.
 *
 * The exec function is injected through {@link HostDeps}, so tests script a
 * fake herdr instead of spawning the binary.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KSTACK_ENTRY } from "../child-agent-runner.ts";
import { getAgentDir } from "../kstack-config.ts";
import { type BoundaryValue, isObject } from "../validation.ts";
import {
	createHerdrCli,
	type HerdrAgentInfo,
	type HerdrCli,
	type HerdrExec,
	type HerdrRunOptions,
} from "./herdr-cli.ts";
import { type AgentPanePlacement, placeAgent } from "./layout.ts";
import { readResponse, responseMarker } from "./response.ts";
import { emptyUsage, readUsageSince, type UsageSummary, usageOffset } from "./session-usage.ts";

const HERDR_INTEGRATION_FILE = "extensions/herdr-agent-state.ts";

export interface HostedAgentSpec {
	/** Role label; becomes part of the agent name: <owner>-<role>-<4 hex>. */
	role: string;
	/** Pi model reference in provider/model[:thinking] form. */
	model: string;
	cwd: string;
	/** `--tools` allowlist; undefined = Pi defaults. */
	tools?: readonly string[];
	/** Repeated `--append-system-prompt`. */
	systemPromptFiles?: readonly string[];
	/** Repeated `--skill` (implies `--no-skills`). */
	skillPaths?: readonly string[];
	noSkills?: boolean;
	noContextFiles?: boolean;
	/** Pi `--name` for the session. */
	sessionName?: string;
	/** Interactive-readiness timeout in ms, 3_000..300_000 (default 30_000). */
	startupTimeoutMs?: number;
}

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

/* exported: hosted-agent interface contract consumed by plan-implement and fanout adapters */
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

export interface AgentHost {
	readonly tabId: string;
	/** 0700 exchange directory for instruction and answer files. */
	readonly exchangeDir: string;
	start(spec: HostedAgentSpec): Promise<{ ok: true; agent: HostedAgent } | { ok: false; error: string }>;
	dispose(options?: { closeTab?: boolean }): Promise<void>;
}

export interface HostDeps {
	exec: HerdrExec;
	env?: NodeJS.ProcessEnv;
	/** Overrides the auto-created exchange directory (tests inject a fixture path). */
	exchangeDir?: string;
	sleep?: (ms: number) => Promise<void>;
}

const ASK_TIMEOUT_MIN_MS = 60_000;
const ASK_TIMEOUT_MAX_MS = 3_600_000;
const START_TIMEOUT_MIN_MS = 3_000;
const START_TIMEOUT_MAX_MS = 300_000;
const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;
const OUTPUT_CAP_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 30_000;
export const POINTER_PROMPT_MAX_BYTES = 512;
const MAX_AGENTS_PER_HOST = 8;
const CONTROL_TIMEOUT_MS = 15_000;
const STALLED_RETRY_DELAY_MS = 2_000;

type HerdrPreflight =
	| { ok: true; integrationPath: string; workspaceId: string; callerPane: string }
	| { ok: false; error: string };

function integrationFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), HERDR_INTEGRATION_FILE);
}

/** Build the Pi argv for one hosted agent. No `--mode json`, no `-p`, no
 * `--session-dir`: the session lands in Pi's normal directory and is visible
 * to `/resume` and session-archive. */
export function hostedAgentArgs(spec: HostedAgentSpec, integrationPath: string): string[] {
	const args = ["--no-extensions", "-e", KSTACK_ENTRY, "-e", integrationPath, "--no-prompt-templates"];
	if (spec.skillPaths && spec.skillPaths.length > 0) {
		args.push("--no-skills");
		for (const path of spec.skillPaths) args.push("--skill", path);
	} else if (spec.noSkills) {
		args.push("--no-skills");
	}
	if (spec.noContextFiles) args.push("--no-context-files");
	if (spec.tools !== undefined) {
		if (spec.tools.length === 0) args.push("--no-tools");
		else args.push("--tools", spec.tools.join(","));
	}
	args.push("--model", spec.model);
	for (const path of spec.systemPromptFiles ?? []) args.push("--append-system-prompt", path);
	args.push(
		"--append-system-prompt",
		"For a hosted request, put the requested KSTACK_RESPONSE acknowledgement on the first line of your final reply, then the complete answer. Role-specific output formats apply to the answer after that line. The host saves the reply; no response-writing tool is needed.",
	);
	if (spec.sessionName) args.push("--name", spec.sessionName);
	return args;
}

/** The fixed pointer prompt sent through the terminal; instructions stay in files. */
export function pointerPrompt(promptFile: string, requestId: string): string {
	return (
		`Read and follow the instructions in ${promptFile}. ` +
		`Return your complete answer in your final reply, starting with the exact line ${responseMarker(requestId)}\n` +
		`The host saves your response; do not write an answer file.`
	);
}

/** Verify the caller runs inside Herdr with the Pi integration installed. Callers run this before any model spend. */
export async function preflightHerdr(deps: HostDeps): Promise<HerdrPreflight> {
	const env = deps.env ?? process.env;
	if (env.HERDR_ENV !== "1") {
		return { ok: false, error: "Herdr is required (HERDR_ENV is not 1). Start the session inside Herdr." };
	}
	const workspaceId = env.HERDR_WORKSPACE_ID ?? "";
	const callerPane = env.HERDR_PANE_ID ?? "";
	if (!workspaceId || !callerPane) {
		return { ok: false, error: "Herdr environment variables HERDR_WORKSPACE_ID and HERDR_PANE_ID are missing." };
	}
	const integrationPath = integrationFilePath(env);
	if (!existsSync(integrationPath)) {
		return {
			ok: false,
			error: `The Herdr Pi integration is missing at ${integrationPath}. Run \`herdr integration install pi\`.`,
		};
	}
	const cli = createHerdrCli(deps.exec);
	const status = await cli.runText(["status", "server"], { timeoutMs: 5_000 });
	if (!status.ok) return { ok: false, error: `Herdr is not reachable: ${status.message}` };
	return { ok: true, integrationPath, workspaceId, callerPane };
}

/** Agent names must match [a-z][a-z0-9_-]{0,31}. */
export function buildAgentName(owner: string, role: string, suffix: string): string {
	let ownerPart = sanitizeNamePart(owner, 31);
	let rolePart = sanitizeNamePart(role, 31);
	const overflow = ownerPart.length + 1 + rolePart.length + 1 + suffix.length - 32;
	if (overflow > 0) {
		rolePart = rolePart.slice(0, Math.max(1, rolePart.length - overflow));
		const overflow2 = ownerPart.length + 1 + rolePart.length + 1 + suffix.length - 32;
		if (overflow2 > 0) ownerPart = ownerPart.slice(0, Math.max(1, ownerPart.length - overflow2));
	}
	return `${ownerPart}-${rolePart}-${suffix}`;
}

function sanitizeNamePart(value: string, max: number): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const withLetterPrefix = /^[a-z]/.test(sanitized) ? sanitized : `a-${sanitized || "agent"}`;
	return withLetterPrefix.slice(0, max).replace(/-+$/g, "");
}

interface CliError {
	code: string;
	message: string;
}

function isNameConflict(error: CliError): boolean {
	const haystack = `${error.code} ${error.message}`.toLowerCase();
	return /name/.test(haystack) && /(taken|exist|conflict|duplicate|in use|already)/.test(haystack);
}

function isTimeoutError(error: CliError): boolean {
	return error.code === "timeout" || /timed? out/i.test(error.message);
}

function randomSuffix(): string {
	return Math.floor(Math.random() * 0xffff)
		.toString(16)
		.padStart(4, "0");
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

function errorText(error: BoundaryValue): string {
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

class HostedAgentImpl implements HostedAgent {
	readonly name: string;
	readonly role: string;
	readonly paneId: string;
	readonly tabId: string;
	sessionFile: string | undefined;
	private readonly cli: HerdrCli;
	private readonly deps: HostDeps;
	private readonly cwd: string;
	private readonly abortPolicy: AbortPolicy;
	private askBusy = false;
	private abortPromise: Promise<void> | undefined;
	private pending: PendingRequest | undefined;
	private closed = false;

	constructor(
		init: {
			name: string;
			role: string;
			cwd: string;
			paneId: string;
			tabId: string;
			sessionFile?: string;
			abortPolicy?: AbortPolicy;
		},
		cli: HerdrCli,
		deps: HostDeps,
	) {
		this.name = init.name;
		this.cwd = init.cwd;
		this.role = init.role;
		this.paneId = init.paneId;
		this.tabId = init.tabId;
		this.sessionFile = init.sessionFile;
		this.abortPolicy = init.abortPolicy ?? "owned";
		this.cli = cli;
		this.deps = deps;
	}

	hasAskInFlight(): boolean {
		return this.askBusy || this.pending !== undefined;
	}

	private sleep(ms: number): Promise<void> {
		return (this.deps.sleep ?? ((delay) => new Promise((resolveSleep) => setTimeout(resolveSleep, delay))))(ms);
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

	private refreshSession(info: HerdrAgentInfo | undefined): void {
		if (info?.sessionFile) this.sessionFile = info.sessionFile;
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
			const current = await this.cli.agentGet({ name: this.name }, { timeoutMs: CONTROL_TIMEOUT_MS });
			if (!current.ok) return emptyFailed(current.message);
			if (!current.value.cwd || canonicalCwd(current.value.cwd) !== canonicalCwd(this.cwd))
				return emptyFailed(`${this.role}: hosted cwd is missing or differs from the assigned cwd.`);
			// A prompt queued behind a human turn settles when that turn ends, before this request ran.
			if (current.value.agentStatus === "working")
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
			let message = `${this.role}: ${errorText(error)}`;
			if (this.abortPolicy === "attached") {
				message += ` Inspect pane ${this.paneId}; the agent was not closed.`;
			}
			return { status: "failed", error: message, usage: this.usage() };
		} finally {
			if (!blocked) {
				request.options.signal?.removeEventListener("abort", request.onAbort);
				this.pending = undefined;
			}
		}
	}

	private observeSettlement(info: HerdrAgentInfo): SendOutcome {
		this.refreshSession(info);
		if (!info.cwd || canonicalCwd(info.cwd) !== canonicalCwd(this.cwd))
			return { status: "failed", error: "Hosted cwd changed during the request.", usage: this.usage() };
		if (this.pending?.sessionFile && this.sessionFile !== this.pending.sessionFile)
			return { status: "failed", error: "Hosted session changed during the request.", usage: this.usage() };
		if (info.agentStatus === "blocked") return { status: "blocked", paneId: this.paneId, usage: this.usage() };
		if (info.agentStatus === "idle" || info.agentStatus === "done") return { settled: true };
		return { status: "failed", error: `Herdr returned an unsettled agent (${info.agentStatus}).`, usage: this.usage() };
	}

	private async sendPointerPrompt(promptText: string, options: AskOptions): Promise<SendOutcome> {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) await this.sleep(STALLED_RETRY_DELAY_MS);
			if (this.pending?.cancelled || options.signal?.aborted) return { status: "aborted", usage: this.usage() };
			const execOptions: HerdrRunOptions = { timeoutMs: options.timeoutMs + 30_000 };
			if (options.signal) execOptions.signal = options.signal;
			const outcome = await this.cli.agentPrompt(
				{ name: this.name, text: promptText, timeoutMs: options.timeoutMs },
				execOptions,
			);
			if (outcome.ok) {
				if (this.pending) this.pending.delivered = true;
				return this.observeSettlement(outcome.value);
			}
			if (options.signal?.aborted) {
				await this.abort();
				return { status: "aborted", usage: this.usage() };
			}
			if (outcome.code === "agent_blocked") return { status: "blocked", paneId: this.paneId, usage: this.usage() };
			if (outcome.code === "agent_prompt_stalled") continue;
			if (isTimeoutError(outcome)) {
				let error = `Timed out after ${Math.round(options.timeoutMs / 1000)}s.`;
				if (this.abortPolicy === "attached") {
					error += ` Inspect pane ${this.paneId}; the agent was not closed.`;
				}
				return { status: "failed", error, usage: this.usage() };
			}
			return { status: "failed", error: `${outcome.code}: ${outcome.message}`, usage: this.usage() };
		}
		return {
			status: "failed",
			error: `${this.role}: agent_prompt_stalled twice; the agent never observed the prompt. Inspect pane ${this.paneId}.`,
			usage: this.usage(),
		};
	}

	private async waitForSettle(options: Omit<AskOptions, "promptFile">): Promise<SendOutcome> {
		const execOptions: HerdrRunOptions = { timeoutMs: options.timeoutMs + 30_000 };
		if (options.signal) execOptions.signal = options.signal;
		const outcome = await this.cli.agentWait(
			{ name: this.name, timeoutMs: options.timeoutMs, until: ["idle", "done"] },
			execOptions,
		);
		if (outcome.ok) return this.observeSettlement(outcome.value);
		if (options.signal?.aborted) {
			await this.abort();
			return { status: "aborted", usage: this.usage() };
		}
		if (isTimeoutError(outcome)) {
			let error = `Timed out after ${Math.round(options.timeoutMs / 1000)}s.`;
			if (this.abortPolicy === "attached") {
				error += ` Inspect pane ${this.paneId}; the agent was not closed.`;
			}
			return { status: "failed", error, usage: this.usage() };
		}
		if (outcome.code === "agent_blocked") return { status: "blocked", paneId: this.paneId, usage: this.usage() };
		return { status: "failed", error: `${outcome.code}: ${outcome.message}`, usage: this.usage() };
	}

	private async collectAnswer(request: PendingRequest): Promise<AskResult> {
		if (!this.sessionFile) throw new Error("Herdr did not report a Pi session file.");
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
			await this.cli.paneClose({ paneId: this.paneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
		} catch {
			/* abort is best effort */
		}
	}

	private async sendKeys(keys: readonly ("esc" | "ctrl+c")[]): Promise<void> {
		try {
			await this.cli.agentSendKeys({ name: this.name, keys }, { timeoutMs: CONTROL_TIMEOUT_MS });
		} catch {
			/* abort is best effort */
		}
	}

	/** The host tab is unseen (`--no-focus`), so herdr reports a settled agent as `done`, not `idle`. */
	private async settles(timeoutMs: number): Promise<boolean> {
		try {
			return await this.cli
				.agentWait({ name: this.name, timeoutMs, until: ["idle", "done"] }, { timeoutMs: timeoutMs + 5_000 })
				.then(
					(outcome) => outcome.ok && (outcome.value.agentStatus === "idle" || outcome.value.agentStatus === "done"),
					() => false,
				);
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
				await this.cli.paneClose({ paneId: this.paneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
			} catch {
				/* dispose is best effort */
			}
		}
	}
}

/** Use the same request lifecycle for a skill's already-running named Pi agent. */
export async function attachHostedAgent(
	name: string,
	deps: HostDeps,
): Promise<{ ok: true; agent: HostedAgent } | { ok: false; error: string }> {
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) return { ok: false, error: "Invalid hosted agent name." };
	const preflight = await preflightHerdr(deps);
	if (!preflight.ok) return preflight;
	const cli = createHerdrCli(deps.exec);
	const found = await cli.agentGet({ name }, { timeoutMs: CONTROL_TIMEOUT_MS });
	if (!found.ok) return { ok: false, error: found.message };
	if (found.value.paneId === preflight.callerPane) return { ok: false, error: "Cannot ask the caller's own pane." };
	if (!found.value.cwd) return { ok: false, error: "Herdr did not report the agent cwd." };
	return {
		ok: true,
		agent: new HostedAgentImpl(
			{ ...found.value, name, role: name, cwd: found.value.cwd, abortPolicy: "attached" },
			cli,
			deps,
		),
	};
}

/** Create the host: preflight, one `--no-focus` tab in the caller's workspace, a 0700 exchange directory. */
export async function openAgentHost(
	options: { owner: string; label: string; cwd: string; maxAgents: number },
	deps: HostDeps,
): Promise<{ ok: true; host: AgentHost } | { ok: false; error: string }> {
	const preflight = await preflightHerdr(deps);
	if (!preflight.ok) return { ok: false, error: preflight.error };
	if (!Number.isInteger(options.maxAgents) || options.maxAgents < 1 || options.maxAgents > MAX_AGENTS_PER_HOST) {
		return { ok: false, error: `maxAgents must be an integer from 1 to ${MAX_AGENTS_PER_HOST}.` };
	}
	const cli = createHerdrCli(deps.exec);
	const tab = await cli.tabCreate(
		{ workspaceId: preflight.workspaceId, cwd: options.cwd, label: `${options.owner}: ${options.label}` },
		{ timeoutMs: CONTROL_TIMEOUT_MS },
	);
	if (!tab.ok) return { ok: false, error: `Could not create the Herdr tab: ${tab.message}` };
	const layout = await cli.paneLayout({ paneId: tab.value.rootPaneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
	const widthColumns = layout.ok ? layout.value.widthColumns : 240;
	const ownsExchangeDir = deps.exchangeDir === undefined;
	const exchangeDir = deps.exchangeDir ?? (await createExchangeDir());
	const agents: HostedAgentImpl[] = [];
	const panes: string[] = [];
	let allocation = Promise.resolve();
	let disposed = false;

	const allocatePane = (spec: HostedAgentSpec): Promise<string> => {
		const next = allocation.then(async () => {
			if (disposed) throw new Error("The agent host is disposed.");
			if (panes.length >= options.maxAgents) throw new Error(`This run hosts at most ${options.maxAgents} agent(s).`);
			const index = panes.length;
			const placement: AgentPanePlacement | undefined = placeAgent(index, options.maxAgents, { widthColumns });
			let paneId = tab.value.rootPaneId;
			if (placement || resolve(spec.cwd) !== resolve(options.cwd)) {
				const sourcePane =
					placement && placement.splitFrom !== "root"
						? (panes[placement.splitFrom] ?? tab.value.rootPaneId)
						: tab.value.rootPaneId;
				const split = await cli.paneSplit(
					{
						paneId: sourcePane,
						direction: placement?.direction ?? "right",
						ratio: placement?.ratio ?? 0.5,
						cwd: spec.cwd,
					},
					{ timeoutMs: CONTROL_TIMEOUT_MS },
				);
				if (!split.ok) throw new Error(`Could not split a pane for ${spec.role}: ${split.message}`);
				paneId = split.value.paneId;
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

	const host: AgentHost = {
		tabId: tab.value.tabId,
		exchangeDir,
		async start(spec) {
			if (disposed) return { ok: false, error: "The agent host is disposed." };
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
				return { ok: false, error: errorText(error) };
			}
			const args = hostedAgentArgs(spec, preflight.integrationPath);
			let lastError: CliError | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				const name = buildAgentName(options.owner, spec.role, randomSuffix());
				let started = await cli.agentStart(
					{ name, paneId, timeoutMs: startupTimeoutMs, args },
					{ timeoutMs: startupTimeoutMs + 30_000 },
				);
				// New panes can precede the shell prompt. Only this rejection proves no agent was launched.
				for (let retry = 0; !started.ok && started.code === "agent_pane_busy" && retry < 3; retry++) {
					await (deps.sleep ?? delay)(1_000);
					if (disposed) return { ok: false, error: "The agent host is disposed." };
					started = await cli.agentStart(
						{ name, paneId, timeoutMs: startupTimeoutMs, args },
						{ timeoutMs: startupTimeoutMs + 30_000 },
					);
				}
				if (started.ok) {
					if (!started.value.cwd || canonicalCwd(started.value.cwd) !== canonicalCwd(spec.cwd))
						return {
							ok: false,
							error: `Herdr started ${spec.role} with a missing or unexpected cwd; expected ${spec.cwd}. No task was sent.`,
						};
					const agent = new HostedAgentImpl(
						{
							name: started.value.name || name,
							role: spec.role,
							cwd: spec.cwd,
							paneId,
							tabId: tab.value.tabId,
							...(started.value.sessionFile ? { sessionFile: started.value.sessionFile } : undefined),
						},
						cli,
						deps,
					);
					agents.push(agent);
					return { ok: true, agent };
				}
				lastError = { code: started.code, message: started.message };
				if (!isNameConflict(started)) {
					return {
						ok: false,
						error: `Could not start ${spec.role} in pane ${paneId}: ${started.message} (${started.code}). Answer any prompt in that pane — typically a project-trust prompt — then retry.`,
					};
				}
			}
			return {
				ok: false,
				error: `Could not start ${spec.role}: agent name conflicts persisted after 3 attempts (${lastError?.message ?? "unknown"}).`,
			};
		},
		async dispose(disposeOptions) {
			if (disposed) return;
			disposed = true;
			await Promise.all(agents.map((agent) => agent.dispose()));
			if (disposeOptions?.closeTab) {
				try {
					await cli.tabClose({ tabId: tab.value.tabId }, { timeoutMs: CONTROL_TIMEOUT_MS });
				} catch {
					/* dispose is best effort */
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
	return { ok: true, host };
}

function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

async function createExchangeDir(): Promise<string> {
	// fs.mkdtemp creates the directory with mode 0700 on POSIX systems.
	return mkdtemp(join(tmpdir(), "kstack-herdr-"));
}
