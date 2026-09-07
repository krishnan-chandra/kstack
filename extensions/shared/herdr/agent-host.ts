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

import { existsSync } from "node:fs";
import { chmod, type FileHandle, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { KSTACK_ENTRY, truncateHeadUtf8 } from "../child-agent-runner.ts";
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
	/** Where the agent must write its complete answer. */
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
	/** After a `blocked` result: wait for idle/done, then collect the answer. */
	resume(options: Omit<AskOptions, "promptFile">): Promise<AskResult>;
	/** esc, then ctrl+c twice, then pane close; each step only when the previous one does not settle the agent. */
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
	if (spec.sessionName) args.push("--name", spec.sessionName);
	return args;
}

/** The fixed pointer prompt sent through the terminal; instructions stay in files. */
export function pointerPrompt(promptFile: string, outputFile: string): string {
	return (
		`Read and follow the instructions in ${promptFile}. ` +
		`Write your complete final response to ${outputFile}. ` +
		`When finished, reply with exactly one line: DONE ${outputFile}`
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

function isUnder(dir: string, path: string): boolean {
	const rel = relative(resolve(dir), resolve(path));
	return rel !== "" && !rel.startsWith("..");
}

/** Pull a `DONE <path>` pointer out of recent terminal output, accepting only paths under the exchange directory. */
export function extractDonePath(text: string, exchangeDir: string): string | undefined {
	for (const line of text.split("\n")) {
		const match = /\bDONE\s+(\S+)\s*$/.exec(line);
		const candidate = match?.[1];
		if (candidate && isUnder(exchangeDir, candidate)) return resolve(candidate);
	}
	return undefined;
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

function truncateToCap(text: string, cap: number): string {
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	return truncateHeadUtf8(text, cap);
}

type SendOutcome = { settled: true } | AskResult;

class HostedAgentImpl implements HostedAgent {
	readonly name: string;
	readonly role: string;
	readonly paneId: string;
	readonly tabId: string;
	sessionFile: string | undefined;
	private readonly cli: HerdrCli;
	private readonly deps: HostDeps;
	private readonly exchangeDir: string;
	private askBusy = false;
	private abortPromise: Promise<void> | undefined;
	private usageOffsetValue: number | undefined;
	private pendingOffset: number | undefined;

	constructor(
		init: { name: string; role: string; paneId: string; tabId: string; sessionFile?: string },
		cli: HerdrCli,
		deps: HostDeps,
		exchangeDir: string,
	) {
		this.name = init.name;
		this.role = init.role;
		this.paneId = init.paneId;
		this.tabId = init.tabId;
		this.sessionFile = init.sessionFile;
		this.cli = cli;
		this.deps = deps;
		this.exchangeDir = exchangeDir;
	}

	hasAskInFlight(): boolean {
		return this.askBusy;
	}

	private sleep(ms: number): Promise<void> {
		return (this.deps.sleep ?? ((delay) => new Promise((resolveSleep) => setTimeout(resolveSleep, delay))))(ms);
	}

	/** Byte offset in the session file where the next ask's usage starts. */
	private offsetBefore(): number {
		if (this.usageOffsetValue === undefined) {
			this.usageOffsetValue = this.sessionFile ? usageOffset(this.sessionFile) : 0;
		}
		return this.usageOffsetValue;
	}

	/** Snapshot the usage window before a prompt is sent so the ask is charged exactly its own appends. */
	private beginUsageWindow(): void {
		this.pendingOffset = this.offsetBefore();
	}

	/** Usage appended since the ask started, advancing the offset. */
	private usage(): UsageSummary {
		if (!this.sessionFile) return emptyUsage();
		const start = this.pendingOffset ?? this.offsetBefore();
		const read = readUsageSince(this.sessionFile, start);
		this.pendingOffset = read.nextOffset;
		this.usageOffsetValue = read.nextOffset;
		return read.usage;
	}

	private refreshSession(info: HerdrAgentInfo | undefined): void {
		if (info?.sessionFile) this.sessionFile = info.sessionFile;
	}

	async ask(options: AskOptions): Promise<AskResult> {
		if (this.askBusy) throw new Error(`Agent ${this.name} already has an ask in flight.`);
		const optionsError = validateAskOptions(options);
		if (optionsError) return emptyFailed(`${this.role}: ${optionsError}`);
		this.askBusy = true;
		try {
			const promptText = pointerPrompt(options.promptFile, options.outputFile);
			if (Buffer.byteLength(promptText, "utf8") > POINTER_PROMPT_MAX_BYTES) {
				return emptyFailed(
					`${this.role}: pointer prompt exceeds ${POINTER_PROMPT_MAX_BYTES} bytes; shorten the instruction and output paths.`,
				);
			}
			const prepared = await this.prepareExchangeFiles(options.promptFile, options.outputFile);
			if (!prepared.ok) return emptyFailed(`${this.role}: ${prepared.error}`);
			this.beginUsageWindow();
			return await this.runAsk(() => this.sendPointerPrompt(promptText, options), {
				outputFile: options.outputFile,
				outputCapBytes: options.outputCapBytes,
				signal: options.signal,
			});
		} finally {
			this.askBusy = false;
		}
	}

	async resume(options: Omit<AskOptions, "promptFile">): Promise<AskResult> {
		if (this.askBusy) throw new Error(`Agent ${this.name} already has an ask in flight.`);
		const optionsError = validateAskOptions(options);
		if (optionsError) return emptyFailed(`${this.role}: ${optionsError}`);
		this.askBusy = true;
		try {
			this.beginUsageWindow();
			return await this.runAsk(() => this.waitForSettle(options), {
				outputFile: options.outputFile,
				outputCapBytes: options.outputCapBytes,
				signal: options.signal,
			});
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
			await chmod(promptFile, 0o600);
			await writeFile(outputFile, "", { mode: 0o600 });
			await chmod(outputFile, 0o600);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: `could not prepare exchange files: ${errorText(error)}` };
		}
	}

	/** Shared ask skeleton: send (or wait), then collect; abort and error paths still report usage. */
	private async runAsk(
		send: () => Promise<SendOutcome>,
		collect: { outputFile: string; outputCapBytes?: number; signal?: AbortSignal },
	): Promise<AskResult> {
		const signal = collect.signal;
		if (signal?.aborted) {
			await this.abort();
			return { status: "aborted", usage: this.usage() };
		}
		const onAbort = (): void => {
			void this.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const sent = await send();
			if (!("settled" in sent)) return sent;
			return await this.collectAnswer(collect.outputFile, collect.outputCapBytes);
		} catch (error) {
			if (signal?.aborted) {
				await this.abort();
				return { status: "aborted", usage: this.usage() };
			}
			return { status: "failed", error: errorText(error), usage: this.usage() };
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async sendPointerPrompt(promptText: string, options: AskOptions): Promise<SendOutcome> {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) await this.sleep(STALLED_RETRY_DELAY_MS);
			const execOptions: HerdrRunOptions = { timeoutMs: options.timeoutMs + 30_000 };
			if (options.signal) execOptions.signal = options.signal;
			const outcome = await this.cli.agentPrompt(
				{ name: this.name, text: promptText, timeoutMs: options.timeoutMs },
				execOptions,
			);
			if (outcome.ok) {
				this.refreshSession(outcome.value);
				if (outcome.value.agentStatus === "blocked") {
					return { status: "blocked", paneId: this.paneId, usage: this.usage() };
				}
				return { settled: true };
			}
			if (options.signal?.aborted) {
				await this.abort();
				return { status: "aborted", usage: this.usage() };
			}
			if (outcome.code === "agent_blocked") return { status: "blocked", paneId: this.paneId, usage: this.usage() };
			if (outcome.code === "agent_prompt_stalled") continue;
			if (isTimeoutError(outcome)) {
				await this.abort();
				return {
					status: "failed",
					error: `Timed out after ${Math.round(options.timeoutMs / 1000)}s.`,
					usage: this.usage(),
				};
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
		if (outcome.ok) {
			this.refreshSession(outcome.value);
			return { settled: true };
		}
		if (options.signal?.aborted) {
			await this.abort();
			return { status: "aborted", usage: this.usage() };
		}
		if (isTimeoutError(outcome)) {
			return {
				status: "failed",
				error: `Timed out after ${Math.round(options.timeoutMs / 1000)}s.`,
				usage: this.usage(),
			};
		}
		if (outcome.code === "agent_blocked") return { status: "blocked", paneId: this.paneId, usage: this.usage() };
		return { status: "failed", error: `${outcome.code}: ${outcome.message}`, usage: this.usage() };
	}

	private async collectAnswer(outputFile: string, outputCapBytes: number | undefined): Promise<AskResult> {
		const cap = outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES;
		const primary = await this.readAnswerFile(outputFile, cap);
		const answer = primary.ok ? primary : await this.fallbackAnswer(cap);
		if (answer.ok) {
			const completed: AskResult = {
				status: "completed",
				output: answer.text,
				usage: this.usage(),
			};
			if (this.sessionFile) completed.session = this.sessionFile;
			return completed;
		}
		return { status: "failed", error: `${this.role} produced no output file.`, usage: this.usage() };
	}

	/** Missing primary output: check recent terminal output for a DONE pointer to a different existing exchange file. */
	private async fallbackAnswer(cap: number): Promise<{ ok: true; text: string } | { ok: false }> {
		try {
			const screen = await this.cli.agentRead({ name: this.name, lines: 200 }, { timeoutMs: CONTROL_TIMEOUT_MS });
			if (!screen.ok) return { ok: false };
			const alternative = extractDonePath(screen.value, this.exchangeDir);
			if (!alternative) return { ok: false };
			return await this.readAnswerFile(alternative, cap);
		} catch {
			return { ok: false };
		}
	}

	private async readAnswerFile(path: string, cap: number): Promise<{ ok: true; text: string } | { ok: false }> {
		if (!Number.isSafeInteger(cap) || cap < 1) return { ok: false };
		let handle: FileHandle | undefined;
		try {
			handle = await open(path, "r");
			const size = (await handle.stat()).size;
			if (size === 0) return { ok: false };
			const bytesToRead = Math.min(size, cap + 4);
			const buffer = Buffer.alloc(bytesToRead);
			const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
			const text = buffer.toString("utf8", 0, bytesRead);
			return { ok: true, text: size > cap ? truncateToCap(text, cap) : text };
		} catch {
			return { ok: false };
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	async abort(): Promise<void> {
		this.abortPromise ??= this.runAbort();
		await this.abortPromise;
	}

	private async runAbort(): Promise<void> {
		await this.sendKey("esc");
		if (await this.settles(2_000)) return;
		await this.sendKey("ctrl+c");
		await this.sleep(1_000);
		await this.sendKey("ctrl+c");
		if (await this.settles(2_000)) return;
		try {
			await this.cli.paneClose({ paneId: this.paneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
		} catch {
			/* abort is best effort */
		}
	}

	private async sendKey(key: "esc" | "ctrl+c"): Promise<void> {
		try {
			await this.cli.agentSendKeys({ name: this.name, key }, { timeoutMs: CONTROL_TIMEOUT_MS });
		} catch {
			/* abort is best effort */
		}
	}

	private async settles(timeoutMs: number): Promise<boolean> {
		try {
			return await this.cli
				.agentWait({ name: this.name, timeoutMs, until: ["idle"] }, { timeoutMs: timeoutMs + 5_000 })
				.then(
					(outcome) => outcome.ok,
					() => false,
				);
		} catch {
			return false;
		}
	}

	async dispose(options?: { closePane?: boolean }): Promise<void> {
		if (options?.closePane) {
			try {
				await this.cli.paneClose({ paneId: this.paneId }, { timeoutMs: CONTROL_TIMEOUT_MS });
			} catch {
				/* dispose is best effort */
			}
		}
	}
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
	let disposed = false;

	const removeExchangeDir = async (): Promise<void> => {
		if (!ownsExchangeDir) return;
		await rm(exchangeDir, { recursive: true, force: true });
	};

	const host: AgentHost = {
		tabId: tab.value.tabId,
		exchangeDir,
		async start(spec) {
			if (disposed) return { ok: false, error: "The agent host is disposed." };
			if (agents.length >= options.maxAgents) {
				return { ok: false, error: `This run hosts at most ${options.maxAgents} agent(s).` };
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
			const index = agents.length;
			const placement: AgentPanePlacement | undefined = placeAgent(index, options.maxAgents, { widthColumns });
			let paneId = tab.value.rootPaneId;
			if (placement) {
				const sourcePane =
					placement.splitFrom === "root"
						? tab.value.rootPaneId
						: (agents[placement.splitFrom]?.paneId ?? tab.value.rootPaneId);
				const split = await cli.paneSplit(
					{ paneId: sourcePane, direction: placement.direction, ratio: placement.ratio },
					{ timeoutMs: CONTROL_TIMEOUT_MS },
				);
				if (!split.ok) return { ok: false, error: `Could not split a pane for ${spec.role}: ${split.message}` };
				paneId = split.value.paneId;
			}
			const args = hostedAgentArgs(spec, preflight.integrationPath);
			let lastError: CliError | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				const name = buildAgentName(options.owner, spec.role, randomSuffix());
				const started = await cli.agentStart(
					{ name, paneId, timeoutMs: startupTimeoutMs, args },
					{ timeoutMs: startupTimeoutMs + 30_000 },
				);
				if (started.ok) {
					const agent = new HostedAgentImpl(
						{
							name: started.value.name || name,
							role: spec.role,
							paneId,
							tabId: tab.value.tabId,
							...(started.value.sessionFile ? { sessionFile: started.value.sessionFile } : undefined),
						},
						cli,
						deps,
						exchangeDir,
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

async function createExchangeDir(): Promise<string> {
	// fs.mkdtemp creates the directory with mode 0700 on POSIX systems.
	return mkdtemp(join(tmpdir(), "kstack-herdr-"));
}
