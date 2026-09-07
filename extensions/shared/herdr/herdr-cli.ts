/** Bounded, validated JSON gateway over the herdr binary.
 *
 * Every herdr response crosses this module exactly once. It parses the
 * `{id, result}` success envelope, the `{id, error:{code,message}}` failure
 * envelope, maps exit code 2 to `syntax_error`, and treats non-JSON output as
 * `protocol_error`. Captured stdout and stderr are capped so a misbehaving
 * CLI cannot exhaust memory. The exec function is injected, so tests script a
 * fake herdr instead of spawning the binary.
 *
 * Response shapes verified against herdr 0.8.2 on 2026-09-07:
 * - `tab create` → `{"result":{"type":"tab_created","tab":…,"root_pane":…}}`
 * - `pane split` → `{"result":{"type":"pane_info","pane":…}}` (the new pane)
 * - `pane close` / `tab close` / `agent send-keys` → `{"result":{"type":"ok"}}`
 * - `agent start` → `{"result":{"type":"agent_started","agent":…,"argv":…}}`
 * - `agent prompt` → `{"result":{"type":"agent_prompted","agent":…}}`
 * - `agent wait` / `agent get` → `{"result":{"type":"agent_info","agent":…}}`
 * - `agent read` prints plain text (no envelope), so it uses `runText`.
 * - errors → stderr JSON `{"id":…,"error":{"code":…,"message":…}}`, exit 1.
 */

import { execFile } from "node:child_process";
import { truncateHeadUtf8 } from "../child-agent-runner.ts";
import { type BoundaryValue, isNumber, isObject, isString, type JsonObject } from "../validation.ts";

export type HerdrExec = (
	args: string[],
	options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface HerdrRunOptions {
	timeoutMs: number;
	signal?: AbortSignal;
}

type HerdrExecOptions = HerdrRunOptions;

type HerdrOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** The subset of a Herdr pane record the agent host needs. */
interface HerdrPaneInfo {
	paneId: string;
	tabId: string;
	agentStatus: string;
}

/** The subset of a Herdr tab record the agent host needs. */
interface HerdrTabInfo {
	tabId: string;
	rootPaneId: string;
}

type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** The subset of a Herdr agent record the agent host needs. */
export interface HerdrAgentInfo {
	name: string;
	cwd?: string;
	agentStatus: HerdrAgentStatus;
	paneId: string;
	tabId: string;
	/** Pi session JSONL path when the Pi integration reported one. */
	sessionFile?: string;
}

export const HERDR_OUTPUT_CAP_BYTES = 64 * 1024;

function cap(text: string, label: string): string {
	return truncateHeadUtf8(text, HERDR_OUTPUT_CAP_BYTES, label);
}

function asStatus(raw: BoundaryValue): HerdrAgentStatus {
	// SAFETY: isString rejects anything outside the five states herdr reports; the fallback is "unknown".
	if (!isString(raw)) return "unknown";
	return raw === "idle" || raw === "working" || raw === "blocked" || raw === "done" ? raw : "unknown";
}

function paneInfoOf(raw: BoundaryValue): HerdrPaneInfo | undefined {
	if (!isObject(raw) || raw === null) return undefined;
	// SAFETY: the guards below validate every field this module reads from the record.
	const record = raw as JsonObject;
	if (!isString(record.pane_id)) return undefined;
	return {
		paneId: record.pane_id,
		tabId: isString(record.tab_id) ? record.tab_id : "",
		agentStatus: asStatus(record.agent_status),
	};
}

function agentInfoOf(raw: BoundaryValue): HerdrAgentInfo | undefined {
	if (!isObject(raw) || raw === null) return undefined;
	// SAFETY: the guards below validate every field this module reads from the record.
	const record = raw as JsonObject;
	if (!isString(record.pane_id)) return undefined;
	const session = isObject(record.agent_session) && record.agent_session !== null ? record.agent_session : undefined;
	// SAFETY: session.value is validated by isString before use.
	const sessionRecord = session as JsonObject | undefined;
	const sessionFile = sessionRecord && isString(sessionRecord.value) ? sessionRecord.value : undefined;
	return {
		name: isString(record.name) ? record.name : "",
		...(isString(record.cwd) ? { cwd: record.cwd } : undefined),
		agentStatus: asStatus(record.agent_status),
		paneId: record.pane_id,
		tabId: isString(record.tab_id) ? record.tab_id : "",
		...(sessionFile ? { sessionFile } : undefined),
	};
}

type EnvelopeParse = { ok: true; result: unknown } | { ok: false; code: string; message: string };

function parseResultEnvelope(stdout: string): EnvelopeParse {
	const trimmed = stdout.trim();
	if (!trimmed) return { ok: false, code: "protocol_error", message: "herdr returned an empty response." };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return {
			ok: false,
			code: "protocol_error",
			message: `herdr returned non-JSON stdout: ${cap(trimmed, "stdout")}`,
		};
	}
	if (!isObject(parsed) || parsed === null || !("result" in parsed)) {
		return {
			ok: false,
			code: "protocol_error",
			message: `herdr stdout had no result envelope: ${cap(trimmed, "stdout")}`,
		};
	}
	// SAFETY: the isObject guard above establishes the envelope is a record.
	return { ok: true, result: (parsed as JsonObject).result };
}

function parseErrorEnvelope(stderr: string): { code: string; message: string } | undefined {
	const trimmed = stderr.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: BoundaryValue = JSON.parse(trimmed);
		if (!isObject(parsed) || parsed === null) return undefined;
		// SAFETY: the isObject guard above establishes the envelope is a record.
		const envelope = parsed as JsonObject;
		const error = envelope.error;
		if (!isObject(error) || error === null) return undefined;
		// SAFETY: the isObject guard above establishes the error is a record.
		const record = error as JsonObject;
		if (!isString(record.message)) return undefined;
		return { code: isString(record.code) ? record.code : "unknown", message: record.message };
	} catch {
		return undefined;
	}
}

export interface HerdrCli {
	/** Run one herdr subcommand and parse its `result` payload. */
	run<T>(
		args: string[],
		parse: (result: BoundaryValue) => T | undefined,
		options: HerdrRunOptions,
	): Promise<HerdrOutcome<T>>;
	/** Run one herdr subcommand whose stdout is plain text (`agent read`). */
	runText(args: string[], options: HerdrRunOptions): Promise<HerdrOutcome<string>>;
	tabCreate(
		options: { workspaceId: string; cwd: string; label: string },
		run: HerdrRunOptions,
	): Promise<HerdrOutcome<HerdrTabInfo>>;
	paneSplit(
		options: { paneId: string; direction: "right" | "down"; ratio: number; cwd?: string },
		run: HerdrRunOptions,
	): Promise<HerdrOutcome<HerdrPaneInfo>>;
	paneClose(options: { paneId: string }, run: HerdrRunOptions): Promise<HerdrOutcome<null>>;
	tabClose(options: { tabId: string }, run: HerdrRunOptions): Promise<HerdrOutcome<null>>;
	agentStart(
		options: { name: string; paneId: string; timeoutMs: number; args: string[] },
		run: HerdrRunOptions,
	): Promise<HerdrOutcome<HerdrAgentInfo>>;
	agentPrompt(
		options: { name: string; text: string; timeoutMs: number; until?: readonly string[] },
		run: HerdrRunOptions,
	): Promise<HerdrOutcome<HerdrAgentInfo>>;
	agentWait(
		options: { name: string; timeoutMs: number; until: readonly string[] },
		run: HerdrRunOptions,
	): Promise<HerdrOutcome<HerdrAgentInfo>>;
	agentGet(options: { name: string }, run: HerdrRunOptions): Promise<HerdrOutcome<HerdrAgentInfo>>;
	agentRead(options: { name: string; lines: number }, run: HerdrRunOptions): Promise<HerdrOutcome<string>>;
	agentSendKeys(options: { name: string; key: "esc" | "ctrl+c" }, run: HerdrRunOptions): Promise<HerdrOutcome<null>>;
	paneLayout(
		options: { paneId: string },
		run: HerdrRunOptions,
	): Promise<HerdrOutcome<{ widthColumns: number; heightRows: number }>>;
}

function expectType<T>(expected: string, project: (result: JsonObject) => T | undefined) {
	return (raw: BoundaryValue): T | undefined => {
		if (!isObject(raw) || raw === null) return undefined;
		// SAFETY: the isObject guard above establishes the result is a record.
		const record = raw as JsonObject;
		if (record.type !== expected) return undefined;
		return project(record);
	};
}

export function createHerdrCli(exec: HerdrExec): HerdrCli {
	const run = async <T>(
		args: string[],
		parse: (result: BoundaryValue) => T | undefined,
		options: HerdrRunOptions,
	): Promise<HerdrOutcome<T>> => {
		const execOptions: HerdrExecOptions = { timeoutMs: options.timeoutMs };
		if (options.signal) execOptions.signal = options.signal;
		const finished = await exec(args, execOptions);
		if (finished.code === 2) {
			const parsed = parseErrorEnvelope(finished.stderr);
			return {
				ok: false,
				code: "syntax_error",
				message: parsed ? parsed.message : `herdr rejected the command syntax: ${cap(finished.stderr, "stderr")}`,
			};
		}
		if (finished.code !== 0) {
			const parsed = parseErrorEnvelope(finished.stderr);
			if (parsed) return { ok: false, code: parsed.code, message: parsed.message };
			return {
				ok: false,
				code: "protocol_error",
				message: `herdr exited ${finished.code} without an error envelope: ${cap(finished.stderr, "stderr")}`,
			};
		}
		const envelope = parseResultEnvelope(finished.stdout);
		if (!envelope.ok) return { ok: false, code: envelope.code, message: envelope.message };
		const value = parse(envelope.result);
		if (value === undefined) {
			return {
				ok: false,
				code: "protocol_error",
				message: `herdr returned an unexpected result shape: ${cap(JSON.stringify(envelope.result), "result")}`,
			};
		}
		return { ok: true, value };
	};

	const runText = async (args: string[], options: HerdrRunOptions): Promise<HerdrOutcome<string>> => {
		const execOptions: HerdrExecOptions = { timeoutMs: options.timeoutMs };
		if (options.signal) execOptions.signal = options.signal;
		const finished = await exec(args, execOptions);
		if (finished.code === 2) {
			return { ok: false, code: "syntax_error", message: cap(finished.stderr, "stderr") };
		}
		if (finished.code !== 0) {
			const parsed = parseErrorEnvelope(finished.stderr);
			if (parsed) return { ok: false, code: parsed.code, message: parsed.message };
			return {
				ok: false,
				code: "protocol_error",
				message: `herdr exited ${finished.code} without an error envelope: ${cap(finished.stderr, "stderr")}`,
			};
		}
		return { ok: true, value: cap(finished.stdout, "output") };
	};

	const agentParse = expectType("agent_info", (record) => {
		const info = agentInfoOf(record.agent);
		return info ? { ...info } : undefined;
	});

	return {
		run,
		runText,
		tabCreate: (options, runOptions) =>
			run(
				[
					"tab",
					"create",
					"--workspace",
					options.workspaceId,
					"--cwd",
					options.cwd,
					"--label",
					options.label,
					"--no-focus",
				],
				expectType("tab_created", (record) => {
					if (!isObject(record.tab) || record.tab === null) return undefined;
					if (!isObject(record.root_pane) || record.root_pane === null) return undefined;
					// SAFETY: the isObject guard above establishes the tab is a record.
					const tab = record.tab as JsonObject;
					// SAFETY: the isObject guard above establishes the root pane is a record.
					const rootPane = record.root_pane as JsonObject;
					if (!isString(tab.tab_id) || !isString(rootPane.pane_id)) return undefined;
					return { tabId: tab.tab_id, rootPaneId: rootPane.pane_id };
				}),
				runOptions,
			),
		paneSplit: (options, runOptions) => {
			const args = [
				"pane",
				"split",
				options.paneId,
				"--direction",
				options.direction,
				"--ratio",
				String(options.ratio),
			];
			if (options.cwd) args.push("--cwd", options.cwd);
			args.push("--no-focus");
			return run(
				args,
				expectType("pane_info", (record) => {
					const info = paneInfoOf(record.pane);
					return info ? { ...info } : undefined;
				}),
				runOptions,
			);
		},
		paneClose: (options, runOptions) =>
			run(
				["pane", "close", options.paneId],
				expectType("ok", () => null),
				runOptions,
			),
		tabClose: (options, runOptions) =>
			run(
				["tab", "close", options.tabId],
				expectType("ok", () => null),
				runOptions,
			),
		agentStart: (options, runOptions) =>
			run(
				[
					"agent",
					"start",
					options.name,
					"--kind",
					"pi",
					"--pane",
					options.paneId,
					"--timeout",
					String(options.timeoutMs),
					"--",
					...options.args,
				],
				expectType("agent_started", (record) => {
					const info = agentInfoOf(record.agent);
					return info ? { ...info, name: options.name } : undefined;
				}),
				runOptions,
			),
		agentPrompt: (options, runOptions) => {
			const args = ["agent", "prompt", options.name, options.text, "--wait", "--timeout", String(options.timeoutMs)];
			for (const state of options.until ?? []) args.push("--until", state);
			return run(
				args,
				expectType("agent_prompted", (record) => {
					const info = agentInfoOf(record.agent);
					return info ? { ...info, name: options.name } : undefined;
				}),
				runOptions,
			);
		},
		agentWait: (options, runOptions) => {
			const args = ["agent", "wait", options.name];
			for (const state of options.until) args.push("--until", state);
			args.push("--timeout", String(options.timeoutMs));
			return run(args, agentParse, runOptions);
		},
		agentGet: (options, runOptions) => run(["agent", "get", options.name], agentParse, runOptions),
		agentRead: (options, runOptions) =>
			runText(
				["agent", "read", options.name, "--source", "recent-unwrapped", "--lines", String(options.lines)],
				runOptions,
			),
		agentSendKeys: (options, runOptions) =>
			run(
				["agent", "send-keys", options.name, options.key],
				expectType("ok", () => null),
				runOptions,
			),
		paneLayout: (options, runOptions) =>
			run(
				["pane", "layout", "--pane", options.paneId],
				expectType("pane_layout", (record) => {
					if (!isObject(record.layout) || record.layout === null) return undefined;
					// SAFETY: the isObject guard above establishes the layout is a record.
					const layout = record.layout as JsonObject;
					if (!isObject(layout.area) || layout.area === null) return undefined;
					// SAFETY: the isObject guard above establishes the area is a record.
					const area = layout.area as JsonObject;
					if (!isNumber(area.width) || !isNumber(area.height)) return undefined;
					return { widthColumns: area.width, heightRows: area.height };
				}),
				runOptions,
			),
	};
}

/** Default exec over the real herdr binary using node's child_process. */
export function createNodeHerdrExec(binary = "herdr"): HerdrExec {
	return async (args, options) =>
		new Promise((resolve) => {
			execFile(
				binary,
				args,
				{
					timeout: options.timeoutMs,
					killSignal: "SIGKILL",
					maxBuffer: HERDR_OUTPUT_CAP_BYTES,
					signal: options.signal,
				},
				(error, stdout, stderr) => {
					// node's execFile reports exit codes on error.code (number) or a system code (string).
					const exitCode = error === null ? 0 : Number.parseInt(String(error.code), 10);
					const code = Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : 1;
					let diagnostic = String(stderr);
					if (error !== null && options.signal?.aborted) {
						diagnostic = JSON.stringify({ error: { code: "aborted", message: "herdr command was aborted" } });
					} else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
						// node kills the child on overflow too; report the cause, not a timeout.
						diagnostic = JSON.stringify({
							error: { code: "output_overflow", message: `herdr output exceeded ${HERDR_OUTPUT_CAP_BYTES} bytes` },
						});
					} else if (error?.killed) {
						diagnostic = JSON.stringify({
							error: { code: "timeout", message: `herdr command timed out after ${options.timeoutMs} ms` },
						});
					} else if (error !== null && diagnostic.length === 0) {
						diagnostic = JSON.stringify({
							error: { code: String(error.code ?? "exec_error"), message: error.message },
						});
					}
					resolve({ code, stdout: String(stdout), stderr: diagnostic });
				},
			);
		});
}
