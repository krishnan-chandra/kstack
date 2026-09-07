/** Bounded fan-out of file-backed tasks through one Herdr AgentHost. */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { mapWithConcurrencyLimit } from "../concurrency.ts";
import { isThinkingLevel, MODEL_ID_RE } from "../kstack-config.ts";
import { type BoundaryValue, isBoolean, isNumber, isObject, isString, type JsonObject } from "../validation.ts";
import { type HostDeps, type HostedAgent, openAgentHost } from "./agent-host.ts";
import { emptyUsage, type UsageSummary } from "./session-usage.ts";

export type FanoutAccess = "read-only" | "workspace";

export interface FanoutTask {
	label: string;
	model: string;
	cwd: string;
	promptFile: string;
	outputFile: string;
	tools?: readonly string[];
	access: FanoutAccess;
	noContextFiles: boolean;
	timeoutMinutes: number;
}

export interface FanoutSpec {
	owner: string;
	label: string;
	cwd: string;
	tasks: FanoutTask[];
	maxConcurrency: number;
}

export type FanoutTaskResult =
	| {
			label: string;
			status: "completed";
			outputFile: string;
			usage: UsageSummary;
			paneId: string;
			sessionFile?: string;
	  }
	| {
			label: string;
			status: "failed" | "blocked" | "aborted";
			outputFile: string;
			usage: UsageSummary;
			paneId?: string;
			sessionFile?: string;
			error: string;
	  };

export interface FanoutOutcome {
	tabId: string;
	results: FanoutTaskResult[];
}

type FanoutSpecParse = { ok: true; spec: FanoutSpec } | { ok: false; error: string };
type FanoutRun = { ok: true; outcome: FanoutOutcome } | { ok: false; error: string };

const MAX_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function modelRefIsValid(ref: string): boolean {
	const separator = ref.lastIndexOf(":");
	if (separator >= 0 && isThinkingLevel(ref.slice(separator + 1))) return MODEL_ID_RE.test(ref.slice(0, separator));
	return MODEL_ID_RE.test(ref);
}

function stringArray(value: BoundaryValue): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings: string[] = [];
	for (const item of value) {
		if (!isString(item)) return undefined;
		strings.push(item);
	}
	return strings;
}

function parseTask(value: BoundaryValue, index: number): { ok: true; task: FanoutTask } | { ok: false; error: string } {
	if (!isObject(value) || value === null || Array.isArray(value)) {
		return { ok: false, error: `tasks[${index}] must be an object.` };
	}
	// SAFETY: the object guard above establishes a string-keyed task record.
	const record = value as JsonObject;
	if (!isString(record.label) || !/^[a-z0-9_-]{1,16}$/.test(record.label)) {
		return { ok: false, error: `tasks[${index}].label must match [a-z0-9_-]{1,16}.` };
	}
	if (!isString(record.model) || !modelRefIsValid(record.model)) {
		return { ok: false, error: `tasks[${index}].model must be provider/model[:thinking].` };
	}
	if (!isString(record.cwd) || !isAbsolute(record.cwd)) {
		return { ok: false, error: `tasks[${index}].cwd must be an absolute path.` };
	}
	if (!isString(record.promptFile) || !isAbsolute(record.promptFile)) {
		return { ok: false, error: `tasks[${index}].promptFile must be an absolute path.` };
	}
	if (!isString(record.outputFile) || !isAbsolute(record.outputFile)) {
		return { ok: false, error: `tasks[${index}].outputFile must be an absolute path.` };
	}
	const access = record.access ?? "read-only";
	if (access !== "read-only" && access !== "workspace") {
		return { ok: false, error: `tasks[${index}].access must be read-only or workspace.` };
	}
	let tools: string[] | undefined;
	if (record.tools !== undefined && record.tools !== null) {
		tools = stringArray(record.tools);
		if (!tools) return { ok: false, error: `tasks[${index}].tools must be null or an array of tool names.` };
	}
	if (access === "read-only" && tools?.some((tool) => !READ_ONLY_TOOLS.has(tool))) {
		return { ok: false, error: `tasks[${index}] read-only tools may include only read, grep, find, and ls.` };
	}
	const noContextFiles = record.noContextFiles ?? true;
	if (!isBoolean(noContextFiles)) return { ok: false, error: `tasks[${index}].noContextFiles must be boolean.` };
	const timeoutMinutes = record.timeoutMinutes ?? 30;
	if (!isNumber(timeoutMinutes) || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
		return { ok: false, error: `tasks[${index}].timeoutMinutes must be an integer from 1 to 60.` };
	}
	return {
		ok: true,
		task: {
			label: record.label,
			model: record.model,
			cwd: record.cwd,
			promptFile: record.promptFile,
			outputFile: record.outputFile,
			tools,
			access,
			noContextFiles,
			timeoutMinutes,
		},
	};
}

/** Parse the CLI JSON spec before it reaches the fan-out domain logic. */
export function parseFanoutSpec(value: BoundaryValue): FanoutSpecParse {
	if (!isObject(value) || value === null || Array.isArray(value)) {
		return { ok: false, error: "fanout spec must be an object." };
	}
	// SAFETY: the object guard above establishes a string-keyed fanout record.
	const record = value as JsonObject;
	if (!isString(record.owner) || !/^[a-z][a-z0-9_-]{0,15}$/.test(record.owner)) {
		return { ok: false, error: "fanout owner must match [a-z][a-z0-9_-]{0,15}." };
	}
	if (!isString(record.label) || record.label.trim().length === 0 || record.label.length > 80) {
		return { ok: false, error: "fanout label must contain 1–80 characters." };
	}
	if (!isString(record.cwd) || !isAbsolute(record.cwd)) return { ok: false, error: "fanout cwd must be absolute." };
	if (!Array.isArray(record.tasks) || record.tasks.length < 1 || record.tasks.length > MAX_TASKS) {
		return { ok: false, error: `fanout tasks must contain 1–${MAX_TASKS} entries.` };
	}
	const tasks: FanoutTask[] = [];
	for (let index = 0; index < record.tasks.length; index++) {
		const parsed = parseTask(record.tasks[index], index);
		if (!parsed.ok) return parsed;
		tasks.push(parsed.task);
	}
	const maxConcurrency = record.maxConcurrency ?? DEFAULT_CONCURRENCY;
	if (
		!isNumber(maxConcurrency) ||
		!Number.isInteger(maxConcurrency) ||
		maxConcurrency < 1 ||
		maxConcurrency > MAX_TASKS
	) {
		return { ok: false, error: `fanout maxConcurrency must be an integer from 1 to ${MAX_TASKS}.` };
	}
	return { ok: true, spec: { owner: record.owner, label: record.label, cwd: record.cwd, tasks, maxConcurrency } };
}

function isSameOrDescendant(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validateTaskPaths(spec: FanoutSpec): string | undefined {
	const labels = new Set<string>();
	const writableDirs: string[] = [];
	let root: string;
	try {
		root = realpathSync(spec.cwd);
	} catch {
		return `fanout cwd does not exist: ${spec.cwd}`;
	}
	for (const task of spec.tasks) {
		if (labels.has(task.label)) return `Duplicate task label: ${task.label}`;
		labels.add(task.label);
		try {
			task.cwd = realpathSync(task.cwd);
			if (!statSync(task.promptFile).isFile()) return `Prompt file does not exist: ${task.promptFile}`;
		} catch {
			return `Task ${task.label} has an unreadable cwd or prompt file.`;
		}
		if (task.access !== "workspace") continue;
		if (isSameOrDescendant(task.cwd, root) || isSameOrDescendant(root, task.cwd)) {
			return `Writable task ${task.label} cannot use, contain, or be inside the repository root.`;
		}
		for (const existing of writableDirs) {
			if (isSameOrDescendant(existing, task.cwd) || isSameOrDescendant(task.cwd, existing)) {
				return `Writable task directories overlap: ${task.cwd} and ${existing}`;
			}
		}
		writableDirs.push(task.cwd);
	}
	return undefined;
}

async function runTask(task: FanoutTask, agent: HostedAgent, signal?: AbortSignal): Promise<FanoutTaskResult> {
	const result = await agent.ask({
		promptFile: task.promptFile,
		outputFile: task.outputFile,
		timeoutMs: task.timeoutMinutes * 60_000,
		signal,
	});
	if (result.status === "completed") {
		const completed: FanoutTaskResult = {
			label: task.label,
			status: "completed",
			outputFile: task.outputFile,
			usage: result.usage,
			paneId: agent.paneId,
		};
		if (result.session) completed.sessionFile = result.session;
		return completed;
	}
	let error = `Task ${task.label} was aborted.`;
	if (result.status === "failed") error = result.error;
	else if (result.status === "blocked") error = `Task ${task.label} is blocked in pane ${result.paneId}.`;
	const failed: FanoutTaskResult = {
		label: task.label,
		status: result.status,
		outputFile: task.outputFile,
		usage: result.usage,
		paneId: agent.paneId,
		error,
	};
	if (agent.sessionFile) failed.sessionFile = agent.sessionFile;
	return failed;
}

/** Run all tasks in one retained Herdr tab and preserve input order. */
export async function runFanout(spec: FanoutSpec, deps: HostDeps, signal?: AbortSignal): Promise<FanoutRun> {
	const pathError = validateTaskPaths(spec);
	if (pathError) return { ok: false, error: pathError };
	const opened = await openAgentHost(
		{ owner: spec.owner, label: spec.label, cwd: realpathSync(spec.cwd), maxAgents: spec.tasks.length },
		deps,
	);
	if (!opened.ok) return opened;
	try {
		const results = await mapWithConcurrencyLimit(
			spec.tasks,
			spec.maxConcurrency,
			async (task): Promise<FanoutTaskResult> => {
				const failure = (error: string): FanoutTaskResult => ({
					label: task.label,
					status: signal?.aborted ? "aborted" : "failed",
					outputFile: task.outputFile,
					usage: emptyUsage(),
					error,
				});
				if (signal?.aborted) return failure("Fanout cancelled before startup.");
				try {
					const tools = task.access === "read-only" ? (task.tools ?? [...READ_ONLY_TOOLS]) : task.tools;
					const started = await opened.host.start({
						role: task.label,
						model: task.model,
						cwd: task.cwd,
						tools,
						noSkills: true,
						noContextFiles: task.noContextFiles,
						sessionName: `${spec.owner}/${task.label}`,
					});
					if (!started.ok) return failure(started.error);
					try {
						return await runTask(task, started.agent, signal);
					} finally {
						// A blocked result is terminal for this CLI, not permission to leave work running.
						await started.agent.dispose();
					}
				} catch (error) {
					return failure(error instanceof Error ? error.message : String(error));
				}
			},
		);
		return { ok: true, outcome: { tabId: opened.host.tabId, results } };
	} finally {
		await opened.host.dispose();
	}
}
