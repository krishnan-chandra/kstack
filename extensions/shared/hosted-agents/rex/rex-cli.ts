/** Bounded, validated CLI gateway over the `rex` binary.
 *
 * Verified against Rex `0.1.0-preview.14` (API revision 12) and Pi `1.5.2`:
 * - `whoami --json` → `{api_revision, session_id, window_id, block_id, rex_version}`
 * - `window new -s S LABEL -c CWD --focus=false --json` → `{window_id, block_ids:[root]}`
 * - `split -s S -b B --split right|below --ratio PCT -c CWD --focus=false --label L --json`
 *   → `{anchor_id, block_ids:[newBlock], split_ids}` (`--ratio` is the new block's 1–99% share)
 * - `block inspect -s S B --json` → `{session_id, block:{block_id, window_id, label}, api:{methods:{...}}}`
 * - `block ls -s S --json` → `{blocks:[{block_id, window_id, label, ...}]}`
 * - `block call -s S -b B size|modes|process|program_status` → JSON objects on stdout
 * - `send-key -s S -b B escape` emits 0x1b; `ctrl+c ctrl+c` delivers both within Pi's 500 ms exit window
 * - exit codes: `0` ok, `2` CLI syntax/flag error, `3` target not found, `4` server unreachable;
 *   errors print plain-text `Error: …` on stderr.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { truncateHeadUtf8, truncateTailUtf8 } from "../../child-agent-runner.ts";
import { asRecord } from "../../narrow.ts";
import { type BoundaryValue, isBoolean, isNumber, isString, type JsonObject } from "../../validation.ts";
import { createNodeExec } from "../node-exec.ts";
import {
	type BackendExec,
	type BackendFailure,
	type ExecOptions,
	type ExecResult,
	execFailureCode,
	type Outcome,
} from "../terminal-backend.ts";

interface RexWhoami {
	apiRevision: number;
	sessionId?: string;
	blockId?: string;
}

interface RexBlockSummary {
	blockId: string;
	label: string;
}

interface RexBlockInspection extends RexBlockSummary {
	windowId: string;
	methods: string[];
}

interface RexBlockSize {
	columns: number;
	rows: number;
	owner: string | null;
}

interface RexProcessEntry {
	pid: number;
	name: string;
	cwd?: string;
}

export interface RexBlockProcess {
	foreground?: RexProcessEntry;
	ancestors: RexProcessEntry[];
}

export interface RexProgramStatusRecord {
	state: string;
	app?: string;
	effectiveApp?: string;
	updatedAt: string;
	owner?: { pid: number; name: string };
}

export type RexKeyName = "escape" | "ctrl+c" | "enter";

interface RexCli {
	whoami(run: ExecOptions): Promise<Outcome<RexWhoami>>;
	windowNew(
		options: { sessionId: string; label: string; cwd: string },
		run: ExecOptions,
	): Promise<Outcome<{ windowId: string; rootBlockId: string }>>;
	split(
		options: {
			sessionId: string;
			blockId: string;
			direction: "right" | "below";
			ratioPercent: number;
			cwd?: string;
			label?: string;
		},
		run: ExecOptions,
	): Promise<Outcome<{ blockId: string }>>;
	blockInspect(options: { sessionId: string; blockId: string }, run: ExecOptions): Promise<Outcome<RexBlockInspection>>;
	blockList(options: { sessionId: string }, run: ExecOptions): Promise<Outcome<RexBlockSummary[]>>;
	blockRename(options: { sessionId: string; blockId: string; label: string }, run: ExecOptions): Promise<Outcome<null>>;
	blockClose(options: { sessionId: string; blockId: string }, run: ExecOptions): Promise<Outcome<null>>;
	windowClose(options: { sessionId: string; windowId: string }, run: ExecOptions): Promise<Outcome<null>>;
	blockSize(options: { sessionId: string; blockId: string }, run: ExecOptions): Promise<Outcome<RexBlockSize>>;
	blockModes(
		options: { sessionId: string; blockId: string },
		run: ExecOptions,
	): Promise<Outcome<{ screen: string; bracketedPaste: boolean }>>;
	blockProcess(options: { sessionId: string; blockId: string }, run: ExecOptions): Promise<Outcome<RexBlockProcess>>;
	blockProgramStatus(
		options: { sessionId: string; blockId: string },
		run: ExecOptions,
	): Promise<Outcome<{ records: RexProgramStatusRecord[] }>>;
	send(options: { sessionId: string; blockId: string; text: string }, run: ExecOptions): Promise<Outcome<null>>;
	sendKeys(
		options: { sessionId: string; blockId: string; keys: readonly RexKeyName[] },
		run: ExecOptions,
	): Promise<Outcome<null>>;
	capture(
		options: { sessionId: string; blockId: string; trim?: boolean; unwrap?: boolean },
		run: ExecOptions,
	): Promise<Outcome<string>>;
}

export const REX_OUTPUT_CAP_BYTES = 64 * 1024;
const REX_EXEC_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function cap(text: string, label: string): string {
	return truncateHeadUtf8(text, REX_OUTPUT_CAP_BYTES, label);
}

function isExecutableFile(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve the `rex` binary from `PATH` first, then `$REX_BIN_DIR/rex`. */
export function resolveRexBinary(env: NodeJS.ProcessEnv = process.env): string {
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		if (!entry) continue;
		const candidate = join(entry, "rex");
		if (isExecutableFile(candidate)) return candidate;
	}
	const binDir = env.REX_BIN_DIR?.trim();
	if (binDir) {
		const candidate = join(binDir, "rex");
		if (isExecutableFile(candidate)) return candidate;
	}
	return "rex";
}

function cleanStderrMessage(stderr: string, fallback: string): string {
	const trimmed = cap(stderr.trim(), "stderr");
	if (!trimmed) return fallback;
	return trimmed.replace(/^Error:\s*/i, "");
}

/**
 * Map a failed `rex` exit to a port error. Exit codes are authoritative; only
 * the generic exit 1 consults message text. `not_found` authorizes stale-seat
 * recovery, so it comes from exit 3 alone and never from message text.
 */
export function mapRexFailure(code: number, stderr: string): BackendFailure {
	const message = cleanStderrMessage(stderr, `rex exited with status ${code}`);
	if (code === 3) return { code: "not_found", message };
	if (code === 4) return { code: "unavailable", message };
	if (code === 1 && /timed? out|deadline exceeded/i.test(message)) return { code: "timeout", message };
	if (code === 1 && /connecting to Rex server|connection refused|server unreachable/i.test(message)) {
		return { code: "unavailable", message };
	}
	return { code: "protocol_error", message };
}

function failureOf(finished: ExecResult): ({ ok: false } & BackendFailure) | undefined {
	if (finished.failure) return { ok: false, code: execFailureCode(finished.failure), message: finished.stderr };
	if (finished.code === 0) return undefined;
	return { ok: false, ...mapRexFailure(finished.code, finished.stderr) };
}

function processEntryOf(raw: BoundaryValue): RexProcessEntry | undefined {
	const record = asRecord(raw);
	if (!record || !isNumber(record.pid) || !isString(record.name)) return undefined;
	return { pid: record.pid, name: record.name, ...(isString(record.cwd) ? { cwd: record.cwd } : undefined) };
}

function blockSummaryOf(raw: BoundaryValue): RexBlockSummary | undefined {
	const record = asRecord(raw);
	if (!record || !isString(record.block_id)) return undefined;
	return { blockId: record.block_id, label: isString(record.label) ? record.label : "" };
}

function statusRecordOf(raw: BoundaryValue): RexProgramStatusRecord | undefined {
	const record = asRecord(raw);
	if (!record || !isString(record.state) || !isString(record.updated_at)) return undefined;
	const ownerRecord = asRecord(record.owner);
	const owner =
		ownerRecord && isNumber(ownerRecord.pid) && isString(ownerRecord.name)
			? { pid: ownerRecord.pid, name: ownerRecord.name }
			: undefined;
	return {
		state: record.state,
		...(isString(record.app) ? { app: record.app } : undefined),
		...(isString(record.effective_app) ? { effectiveApp: record.effective_app } : undefined),
		updatedAt: record.updated_at,
		...(owner ? { owner } : undefined),
	};
}

/** Parse every element or reject the whole array. */
function allOf<T>(raw: BoundaryValue, parse: (item: BoundaryValue) => T | undefined): T[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const parsed: T[] = [];
	for (const item of raw) {
		const value = parse(item);
		if (value === undefined) return undefined;
		parsed.push(value);
	}
	return parsed;
}

function firstBlockId(record: JsonObject): string | undefined {
	if (!Array.isArray(record.block_ids)) return undefined;
	const first = record.block_ids[0];
	return isString(first) ? first : undefined;
}

export function createRexCli(exec: BackendExec): RexCli {
	const runJson = async <T>(
		args: string[],
		parse: (record: JsonObject) => T | undefined,
		options: ExecOptions,
	): Promise<Outcome<T>> => {
		const finished = await exec(args, options);
		const failed = failureOf(finished);
		if (failed) return failed;
		const trimmed = finished.stdout.trim();
		if (!trimmed) return { ok: false, code: "protocol_error", message: "rex returned empty JSON stdout." };
		let parsed: BoundaryValue;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return { ok: false, code: "protocol_error", message: `rex returned non-JSON stdout: ${cap(trimmed, "stdout")}` };
		}
		const record = asRecord(parsed);
		const projected = record ? parse(record) : undefined;
		if (projected === undefined) {
			return {
				ok: false,
				code: "protocol_error",
				message: `rex returned an unexpected JSON shape: ${cap(trimmed, "stdout")}`,
			};
		}
		return { ok: true, value: projected };
	};

	const runVoid = async (args: string[], options: ExecOptions): Promise<Outcome<null>> => {
		const failed = failureOf(await exec(args, options));
		return failed ?? { ok: true, value: null };
	};

	const runText = async (args: string[], options: ExecOptions): Promise<Outcome<string>> => {
		const finished = await exec(args, options);
		const failed = failureOf(finished);
		return failed ?? { ok: true, value: truncateTailUtf8(finished.stdout, REX_OUTPUT_CAP_BYTES) };
	};

	const blockCall = <T>(
		options: { sessionId: string; blockId: string },
		method: string,
		parse: (record: JsonObject) => T | undefined,
		runOptions: ExecOptions,
	) => runJson(["block", "call", "-s", options.sessionId, "-b", options.blockId, method], parse, runOptions);

	return {
		whoami: (runOptions) =>
			runJson(
				["whoami", "--json"],
				(record) => {
					if (!isNumber(record.api_revision)) return undefined;
					return {
						apiRevision: record.api_revision,
						...(isString(record.session_id) ? { sessionId: record.session_id } : undefined),
						...(isString(record.block_id) ? { blockId: record.block_id } : undefined),
					};
				},
				runOptions,
			),
		windowNew: (options, runOptions) =>
			runJson(
				["window", "new", "-s", options.sessionId, options.label, "-c", options.cwd, "--focus=false", "--json"],
				(record) => {
					const rootBlockId = firstBlockId(record);
					if (!isString(record.window_id) || !rootBlockId) return undefined;
					return { windowId: record.window_id, rootBlockId };
				},
				runOptions,
			),
		split: (options, runOptions) => {
			const args = [
				"split",
				"-s",
				options.sessionId,
				"-b",
				options.blockId,
				"--split",
				options.direction,
				"--ratio",
				String(options.ratioPercent),
			];
			if (options.cwd) args.push("-c", options.cwd);
			if (options.label) args.push("--label", options.label);
			args.push("--focus=false", "--json");
			return runJson(
				args,
				(record) => {
					const blockId = firstBlockId(record);
					return blockId ? { blockId } : undefined;
				},
				runOptions,
			);
		},
		blockInspect: (options, runOptions) =>
			runJson(
				["block", "inspect", "-s", options.sessionId, options.blockId, "--json"],
				(record) => {
					const summary = blockSummaryOf(record.block);
					const block = asRecord(record.block);
					const methods = asRecord(asRecord(record.api)?.methods);
					if (!summary || !block || !isString(block.window_id) || !methods) return undefined;
					return { ...summary, windowId: block.window_id, methods: Object.keys(methods) };
				},
				runOptions,
			),
		blockList: (options, runOptions) =>
			runJson(
				["block", "ls", "-s", options.sessionId, "--json"],
				(record) => allOf(record.blocks, blockSummaryOf),
				runOptions,
			),
		blockRename: (options, runOptions) =>
			runVoid(["block", "rename", "-s", options.sessionId, options.blockId, options.label], runOptions),
		blockClose: (options, runOptions) =>
			runVoid(["block", "close", "-s", options.sessionId, options.blockId], runOptions),
		windowClose: (options, runOptions) =>
			runVoid(["window", "close", "-s", options.sessionId, options.windowId], runOptions),
		blockSize: (options, runOptions) =>
			blockCall(
				options,
				"size",
				(record) => {
					if (!isNumber(record.columns) || !isNumber(record.rows)) return undefined;
					return { columns: record.columns, rows: record.rows, owner: isString(record.owner) ? record.owner : null };
				},
				runOptions,
			),
		blockModes: (options, runOptions) =>
			blockCall(
				options,
				"modes",
				(record) => {
					if (!isString(record.screen) || !Array.isArray(record.modes)) return undefined;
					// Rex lists every mode it tracks; a missing bracketed-paste entry is a protocol change.
					const mode = record.modes
						.map(asRecord)
						.find((entry) => entry?.name === "bracketed_paste" || entry?.number === 2004);
					if (!mode || !isBoolean(mode.set)) return undefined;
					return { screen: record.screen, bracketedPaste: mode.set };
				},
				runOptions,
			),
		blockProcess: (options, runOptions) =>
			blockCall(
				options,
				"process",
				(record) => {
					const foreground = processEntryOf(record.foreground);
					const ancestors = Array.isArray(record.ancestors)
						? record.ancestors.flatMap((item) => processEntryOf(item) ?? [])
						: [];
					return { ...(foreground ? { foreground } : undefined), ancestors };
				},
				runOptions,
			),
		blockProgramStatus: (options, runOptions) =>
			blockCall(
				options,
				"program_status",
				(record) => {
					const records = allOf(record.records, statusRecordOf);
					return records ? { records } : undefined;
				},
				runOptions,
			),
		send: (options, runOptions) =>
			runVoid(["send", "-s", options.sessionId, "-b", options.blockId, "--", options.text], runOptions),
		sendKeys: (options, runOptions) =>
			runVoid(["send-key", "-s", options.sessionId, "-b", options.blockId, ...options.keys], runOptions),
		capture: (options, runOptions) => {
			const args = ["capture", "-s", options.sessionId, "-b", options.blockId];
			if (options.trim) args.push("--trim");
			if (options.unwrap) args.push("--unwrap");
			return runText(args, runOptions);
		},
	};
}

/** Default exec over the real `rex` binary. */
export function createNodeRexExec(env: NodeJS.ProcessEnv = process.env, binary?: string): BackendExec {
	return createNodeExec(binary ?? resolveRexBinary(env), {
		label: "rex",
		maxBufferBytes: REX_EXEC_MAX_BUFFER_BYTES,
		env,
	});
}
